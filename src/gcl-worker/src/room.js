// Room: one instance per gats server. Holds who is online, in memory only.
// Uses hibernating WebSockets, so an idle room costs nothing.
//
// Truth lives in each socket's attachment ({uid, name, ver, gid, seen, joinedAt}),
// so everything survives hibernation without touching storage.
//
// Client -> room:  "ping" (text, answered automatically with "pong", never wakes the DO)
//                  {"t":"join","gid":"12"}  {"t":"leave"}  {"t":"lookup","ids":["3","9"]}
// Room -> client:  welcome / join / leave / rename / names / joined / denied / revoked

import { DurableObject } from 'cloudflare:workers';

const MAX_SOCKETS = 200;
const ALARM_MS = 120_000;     // cleanup + revalidation cadence while anyone is connected
const STALE_MS = 180_000;     // no ping/message for this long => dropped
const CACHE_MS = 300_000;     // how long a D1 user row is trusted
const GID_RE = /^[A-Za-z0-9_-]{1,12}$/;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cache = new Map(); // uid -> { row, at }   (fallback cache over D1)
    // Heartbeats are answered by the runtime itself: no wake-up, no billed request.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---- HTTP entry (only the Worker can reach this) ------------------------

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/rename' && request.method === 'POST') {
      const { uid, name } = await request.json();
      this.applyRename(uid, name);
      return new Response('ok');
    }
    if (url.pathname === '/revalidate' && request.method === 'POST') {
      this.cache.clear();
      await this.revalidate();
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const uid = request.headers.get('x-gcl-uid');
    const ver = Number(request.headers.get('x-gcl-ver'));
    const user = await this.loadUser(uid);
    if (!user || user.banned || user.token_version !== ver) return new Response('revoked', { status: 403 });

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response('room full', { status: 503 });

    // One live socket per account: the newer one replaces the older.
    for (const s of sockets) {
      const a = s.deserializeAttachment();
      if (a && a.uid === uid) this.dropSocket(s, 4000, 'replaced');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, name: user.username, ver, gid: null, joinedAt: Date.now(), seen: Date.now() });
    server.send(JSON.stringify({ t: 'welcome', name: user.username, roster: this.roster() }));

    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);

    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' } });
  }

  // ---- WebSocket handlers --------------------------------------------------

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m || typeof m !== 'object') return;
    a.seen = Date.now();

    if (m.t === 'join') {
      const gid = String(m.gid ?? '');
      if (!GID_RE.test(gid)) return;
      const holder = this.holderOf(gid);
      if (holder && holder !== a.uid) {          // first claim wins while the claimant is connected
        ws.send(JSON.stringify({ t: 'denied', gid }));
      } else {
        if (a.gid && a.gid !== gid) this.broadcast({ t: 'leave', gid: a.gid }, a.uid);
        a.gid = gid;
        this.broadcast({ t: 'join', gid, name: a.name }, a.uid);
        ws.send(JSON.stringify({ t: 'joined', gid }));
      }
    } else if (m.t === 'leave') {
      if (a.gid) { this.broadcast({ t: 'leave', gid: a.gid }, a.uid); a.gid = null; }
    } else if (m.t === 'lookup') {
      const ids = Array.isArray(m.ids) ? m.ids.slice(0, 50) : [];
      const map = {};
      for (const id of ids) {
        const name = this.nameOfGid(String(id));
        if (name) map[id] = name;
      }
      ws.send(JSON.stringify({ t: 'names', map }));
    }
    ws.serializeAttachment(a);
  }

  async webSocketClose(ws, code) {
    this.cleanup(ws);
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    this.cleanup(ws);
  }

  // Runs every ALARM_MS while sockets exist: drop stale sockets, then re-check
  // everyone against D1 in one batched read (this is how bans/revocations land).
  async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a.seen || a.joinedAt || 0, auto ? auto.getTime() : 0);
      if (now - last > STALE_MS) this.dropSocket(ws, 4002, 'stale');
    }
    try { await this.revalidate(); } catch (e) { console.error('revalidate failed', e); }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  // ---- helpers -------------------------------------------------------------

  async loadUser(uid) {
    if (!uid) return null;
    const c = this.cache.get(uid);
    if (c && Date.now() - c.at < CACHE_MS) return c.row;
    const row = await this.env.DB
      .prepare('SELECT id, username, banned, token_version FROM users WHERE id = ?')
      .bind(uid).first();
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(uid, { row: row || null, at: Date.now() });
    return row || null;
  }

  async revalidate() {
    const byUid = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.uid) continue;
      if (!byUid.has(a.uid)) byUid.set(a.uid, []);
      byUid.get(a.uid).push([ws, a]);
    }
    const uids = [...byUid.keys()];
    if (!uids.length) return;

    const rows = new Map();
    for (let i = 0; i < uids.length; i += 80) {          // D1 allows ~100 bound params per query
      const chunk = uids.slice(i, i + 80);
      const sql = `SELECT id, username, banned, token_version FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`;
      const res = await this.env.DB.prepare(sql).bind(...chunk).all();
      for (const r of res.results) rows.set(r.id, r);
    }

    const now = Date.now();
    for (const [uid, list] of byUid) {
      const row = rows.get(uid) || null;
      this.cache.set(uid, { row, at: now });
      for (const [ws, a] of list) {
        if (!row || row.banned || row.token_version !== a.ver) {
          try { ws.send(JSON.stringify({ t: 'revoked' })); } catch {}
          this.dropSocket(ws, 4001, 'revoked');
        } else if (row.username !== a.name) {
          a.name = row.username;
          ws.serializeAttachment(a);
          if (a.gid) this.broadcast({ t: 'rename', gid: a.gid, name: row.username });
        }
      }
    }
  }

  applyRename(uid, name) {
    const c = this.cache.get(uid);
    if (c && c.row) c.row.username = name;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.uid === uid) {
        a.name = name;
        ws.serializeAttachment(a);
        if (a.gid) this.broadcast({ t: 'rename', gid: a.gid, name });
      }
    }
  }

  cleanup(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.gid) {
      this.broadcast({ t: 'leave', gid: a.gid }, a.uid);
      a.gid = null;
      try { ws.serializeAttachment(a); } catch {}
    }
  }

  dropSocket(ws, code, reason) {
    this.cleanup(ws);
    try { ws.close(code, reason); } catch {}
  }

  roster() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.gid) out.push([a.gid, a.name]);
    }
    return out;
  }

  holderOf(gid) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.gid === gid) return a.uid;
    }
    return null;
  }

  nameOfGid(gid) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.gid === gid) return a.name;
    }
    return null;
  }

  broadcast(obj, exceptUid) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (exceptUid && a && a.uid === exceptUid) continue;
      try { ws.send(s); } catch {}
    }
  }
}
