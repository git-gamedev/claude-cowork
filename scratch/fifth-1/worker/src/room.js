// room.js — PresenceRoom Durable Object. One instance per gats server ("room").
//
// Hot state (who is connected, which in-game id they claim, display name) lives
// on the hibernating WebSockets themselves via serializeAttachment(), so it
// survives hibernation without ever touching SQLite storage.
//
// Heartbeats: the client sends the text "ping"; setWebSocketAutoResponse answers
// "pong" WITHOUT waking the object. Last-seen comes from
// getWebSocketAutoResponseTimestamp().
//
// D1 is read only (a) when someone connects and (b) when a socket's cached
// token-version/ban check is older than REVALIDATE_SECONDS. Both are batched.
//
// Client -> DO (JSON text):  {t:'claim',gid} {t:'unclaim'} {t:'lookup',gids:[..]}
// DO -> client (JSON text):  {t:'hello',name} {t:'claimed',gid} {t:'claim_err',gid,reason}
//                            {t:'names',names:{gid:name}} {t:'join',gid,name}
//                            {t:'leave',gid} {t:'rename',gid,name} {t:'revoked'}

import { DurableObject } from 'cloudflare:workers';
import { GID_RE, intVar } from './lib.js';

const STALE_MS = 120000;       // no heartbeat for this long -> treat socket as dead
const OPEN = 1;                // WebSocket.OPEN
const MSG_WINDOW_MS = 10000;
const MSG_MAX_PER_WINDOW = 40; // per socket

export class PresenceRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.userCache = new Map();   // uid -> { exists, name, ver, banned, at }  (in-memory only)
    this.msgRate = new WeakMap(); // ws -> { start, n }
    this.lastSweep = 0;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---- entry point ---------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return this.onConnect(request);
    }
    if (request.method === 'POST' && url.pathname === '/rename' &&
        request.headers.get('x-gcl-internal') === '1') {
      const { uid, name } = await request.json();
      this.applyRename(uid, name);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  // ---- connect -------------------------------------------------------------
  async onConnect(request) {
    const uid = parseInt(request.headers.get('x-gcl-uid'), 10);
    const ver = parseInt(request.headers.get('x-gcl-ver'), 10);
    if (!Number.isInteger(uid) || !Number.isInteger(ver)) {
      return new Response('bad request', { status: 400 });
    }

    const st = await this.userState(uid);   // cached, else one D1 read

    if (!st.exists || st.ver !== ver) return this.reject(4401, 'revoked');
    if (st.banned) return this.reject(4403, 'banned');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const resp = new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' },
    });

    // one presence socket per user per room: the newest wins
    for (const old of this.ctx.getWebSockets()) {
      if (old === server) continue;
      const a = old.deserializeAttachment();
      if (a && a.uid === uid) {
        this.dropClaim(old, a);
        this.send(old, { t: 'replaced' });
        try { old.close(4000, 'replaced'); } catch {}
      }
    }

    const now = Date.now();
    server.serializeAttachment({ uid, name: st.name, ver, gid: null, joinedAt: now, checkedAt: now });
    this.send(server, { t: 'hello', name: st.name });
    await this.maybeSweep();
    return resp;
  }

  // A rejected connection never joins the room: it is a plain (non-hibernating)
  // socket that is accepted, told why, and closed with an app close code.
  reject(code, reason) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(JSON.stringify({ t: 'revoked' }));
    server.close(code, reason);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' },
    });
  }

  // ---- hibernation handlers ------------------------------------------------
  async webSocketMessage(ws, message) {
    try {
      const a = ws.deserializeAttachment();
      if (!a || typeof message !== 'string' || message.length > 4096) return;
      if (this.overRate(ws)) { ws.close(4429, 'rate'); return; }

      let m;
      try { m = JSON.parse(message); } catch { return; }
      if (!m || typeof m !== 'object') return;

      switch (m.t) {
        case 'claim':   this.onClaim(ws, a, m); break;
        case 'unclaim': this.dropClaim(ws, a); break;
        case 'lookup':  this.onLookup(ws, m); break;
        default: break;
      }
      await this.maybeSweep();
    } catch (e) {
      console.error('webSocketMessage error', e && e.stack ? e.stack : e);
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    this.dropClaim(ws, ws.deserializeAttachment(), true);
  }

  async webSocketError(ws) {
    this.dropClaim(ws, ws.deserializeAttachment(), true);
  }

  // ---- claim / lookup ------------------------------------------------------
  // A claim says "the in-game player id <gid> on this server is me". First
  // claim wins; a claim by someone else is refused while the holder is alive.
  onClaim(ws, a, m) {
    const gid = String(m.gid == null ? '' : m.gid);
    if (!GID_RE.test(gid)) { this.send(ws, { t: 'claim_err', gid, reason: 'bad_gid' }); return; }
    if (a.gid === gid) { this.send(ws, { t: 'claimed', gid }); return; }

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const oa = other.deserializeAttachment();
      if (!oa || oa.gid !== gid) continue;
      if (oa.uid === a.uid) { this.dropClaim(other, oa); continue; }
      if (this.isStale(other, oa)) { this.dropClaim(other, oa); try { other.close(1001, 'stale'); } catch {} continue; }
      this.send(ws, { t: 'claim_err', gid, reason: 'taken' });
      return;
    }

    if (a.gid) this.broadcast({ t: 'leave', gid: a.gid }, ws);
    a.gid = gid;
    ws.serializeAttachment(a);
    this.send(ws, { t: 'claimed', gid });
    this.broadcast({ t: 'join', gid, name: a.name }, ws);
  }

  onLookup(ws, m) {
    if (!Array.isArray(m.gids)) return;
    const wanted = new Set(m.gids.slice(0, 50).map(String).filter((g) => GID_RE.test(g)));
    if (!wanted.size) return;
    const names = {};
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment();
      if (a && a.gid && wanted.has(a.gid) && s.readyState === OPEN) names[a.gid] = a.name;
    }
    this.send(ws, { t: 'names', names });
  }

  // Release a socket's claim and tell everyone (unless another socket holds it).
  dropClaim(ws, a, closing = false) {
    if (!a || !a.gid) return;
    const gid = a.gid;
    a.gid = null;
    if (!closing) { try { ws.serializeAttachment(a); } catch {} }
    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      const sa = s.deserializeAttachment();
      if (sa && sa.gid === gid) return;
    }
    this.broadcast({ t: 'leave', gid }, ws);
  }

  // ---- rename push from the Worker ----------------------------------------
  applyRename(uid, name) {
    const c = this.userCache.get(uid);
    if (c) c.name = name;
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment();
      if (!a || a.uid !== uid || a.name === name) continue;
      a.name = name;
      s.serializeAttachment(a);
      if (a.gid) this.broadcast({ t: 'rename', gid: a.gid, name }, s);
    }
  }

  // ---- user state (revocation check) --------------------------------------
  async userState(uid) {
    const ttl = intVar(this.env, 'REVALIDATE_SECONDS', 120) * 1000;
    const c = this.userCache.get(uid);
    if (c && Date.now() - c.at < ttl) return c;
    const row = await this.env.DB.prepare(
      'SELECT username, token_version, banned FROM users WHERE id = ?1'
    ).bind(uid).first();
    const st = row
      ? { exists: true, name: row.username, ver: row.token_version, banned: !!row.banned, at: Date.now() }
      : { exists: false, name: '', ver: -1, banned: false, at: Date.now() };
    this.userCache.set(uid, st);
    return st;
  }

  // ---- housekeeping (no alarms, so an idle room costs nothing) --------------
  // Runs opportunistically on connects/messages, at most once per 30 s (or per
  // REVALIDATE_SECONDS if that is shorter):
  //  - closes sockets with no heartbeat for STALE_MS
  //  - re-checks token version / ban / name for sockets whose check is old,
  //    using ONE batched D1 query per 50 users
  async maybeSweep() {
    const now = Date.now();
    const ttl = intVar(this.env, 'REVALIDATE_SECONDS', 120) * 1000;
    if (now - this.lastSweep < Math.min(30000, ttl)) return;
    this.lastSweep = now;

    const due = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      if (this.isStale(ws, a)) { this.dropClaim(ws, a); try { ws.close(1001, 'stale'); } catch {} continue; }
      if (now - a.checkedAt >= ttl) due.push([ws, a]);
    }
    if (!due.length) return;

    const uids = [...new Set(due.map(([, a]) => a.uid))];
    const rows = new Map();
    for (let i = 0; i < uids.length; i += 50) {
      const chunk = uids.slice(i, i + 50);
      const q = `SELECT id, username, token_version, banned FROM users WHERE id IN (${chunk.map((_, j) => '?' + (j + 1)).join(',')})`;
      const res = await this.env.DB.prepare(q).bind(...chunk).all();
      for (const r of res.results) rows.set(r.id, r);
    }

    for (const [ws, a] of due) {
      const r = rows.get(a.uid);
      this.userCache.set(a.uid, r
        ? { exists: true, name: r.username, ver: r.token_version, banned: !!r.banned, at: now }
        : { exists: false, name: '', ver: -1, banned: false, at: now });

      if (!r || r.token_version !== a.ver || r.banned) {
        this.send(ws, { t: 'revoked' });
        this.dropClaim(ws, a);
        try { ws.close(r && r.banned ? 4403 : 4401, 'revoked'); } catch {}
        continue;
      }
      a.checkedAt = now;
      if (r.username !== a.name) {
        a.name = r.username;
        if (a.gid) this.broadcast({ t: 'rename', gid: a.gid, name: a.name }, ws);
      }
      ws.serializeAttachment(a);
    }
  }

  isStale(ws, a) {
    const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    const last = Math.max(ts ? ts.getTime() : 0, a.joinedAt || 0);
    return Date.now() - last > STALE_MS;
  }

  overRate(ws) {
    const now = Date.now();
    let r = this.msgRate.get(ws);
    if (!r || now - r.start > MSG_WINDOW_MS) { r = { start: now, n: 0 }; this.msgRate.set(ws, r); }
    r.n++;
    return r.n > MSG_MAX_PER_WINDOW;
  }

  // ---- send helpers --------------------------------------------------------
  send(ws, obj) {
    try { if (ws.readyState === OPEN) ws.send(JSON.stringify(obj)); } catch {}
  }

  broadcast(obj, except) {
    const msg = JSON.stringify(obj);
    for (const s of this.ctx.getWebSockets()) {
      if (s === except || s.readyState !== OPEN) continue;
      if (!s.deserializeAttachment()) continue;
      try { s.send(msg); } catch {}
    }
  }
}
