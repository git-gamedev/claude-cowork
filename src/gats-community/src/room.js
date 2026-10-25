// Durable Objects.
//  Room: one per gats server. Hibernating WebSockets. Per-socket state lives in the socket
//        attachment (survives hibernation); no SQLite writes. D1 is read only as a fallback.
//  Gate (rate limiting) lives in gate.js.
//
// Memory design: ws.deserializeAttachment() structured-clones the attachment on EVERY call, so
// scanning all sockets per message allocated O(N) objects per operation. Instead each wake builds
// one index once (uid -> { ws, a } and pid -> uid) and every handler works on those live objects.
// Only the attachment fields that must survive hibernation are re-serialized, and only when they change.

import { DurableObject } from 'cloudflare:workers';

const TIMEOUT_MS = 90_000;   // drop sockets silent for this long
const ALARM_MS = 300_000;    // sweep interval while anyone is connected (5 min: keeps DO requests inside the free cap)
const CACHE_TTL = 300_000;
const CACHE_MAX = 256;       // a room holds at most a few hundred players; bounded, oldest evicted first
const CHUNK = 80;            // D1 bound-parameter limit per query is ~100
const PID_RE = /^[A-Za-z0-9_-]{1,12}$/;

const placeholders = new Map(); // n -> "?1,?2,...,?n" (built once per distinct n, not per sweep)
function ph(n) {
  let s = placeholders.get(n);
  if (!s) { s = Array.from({ length: n }, (_, i) => '?' + (i + 1)).join(','); placeholders.set(n, s); }
  return s;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cache = new Map();      // uid -> { name, tv, banned, at }  (lost on eviction: rebuilt from D1)
    this.idx = null;             // uid -> { ws, a }   built lazily, once per wake
    this.pids = null;            // pid -> uid
    this.byWs = new WeakMap();   // ws -> entry (fast path; falls back to the attachment if identity differs)
    this.seq = 0;
    // "ping" -> "pong" is answered by the runtime WITHOUT waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---- index ----
  index() {
    if (!this.idx) {
      this.idx = new Map();
      this.pids = new Map();
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();           // the only clone per socket per wake
        if (!a) { try { ws.close(4001, 'no state'); } catch {} continue; }
        const old = this.idx.get(a.uid);
        if (old) { try { old.ws.close(4000, 'replaced'); } catch {} if (old.a.pid) this.pids.delete(old.a.pid); }
        const e = { ws, a };
        this.idx.set(a.uid, e);
        this.byWs.set(ws, e);
        if (a.pid) this.pids.set(a.pid, a.uid);
      }
    }
    return this.idx;
  }

  entryOf(ws) {
    const idx = this.index();
    let e = this.byWs.get(ws);
    if (e && idx.get(e.a.uid) === e) return e;
    const a = ws.deserializeAttachment();
    e = a && idx.get(a.uid);
    if (!e || e.a.sid !== a.sid) return null;           // stale socket (already replaced or dropped)
    this.byWs.set(ws, e);
    return e;
  }

  // ---- user cache (D1 fallback) ----
  putRec(uid, name, tv, banned) {
    let r = this.cache.get(uid);
    if (!r) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      r = {};
      this.cache.set(uid, r);
    }
    r.name = name; r.tv = tv; r.banned = banned; r.at = Date.now();
    return r;
  }

  async userRec(uid) {
    const c = this.cache.get(uid);
    if (c && Date.now() - c.at < CACHE_TTL) return c;
    const row = await this.env.DB.prepare('SELECT username,token_version,banned FROM users WHERE id=?1').bind(uid).first();
    if (!row) { this.cache.delete(uid); return null; }
    return this.putRec(uid, row.username, row.token_version, !!row.banned);
  }

  // ---- HTTP (only the Worker can reach this object) ----
  async fetch(request) {
    const url = request.url;

    if (url.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const uid = request.headers.get('x-uid');
      const tv = Number(request.headers.get('x-tv'));
      const rec = uid ? await this.userRec(uid) : null;
      if (!rec || rec.banned || rec.tv !== tv) return new Response('revoked', { status: 401 });

      const old = this.index().get(uid);                // one live presence socket per account per room
      if (old) this.kill(old, 4000, 'replaced');

      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      const a = { uid, name: rec.name, tv, pid: null, gname: '', seen: Date.now(), sid: Date.now().toString(36) + '.' + (++this.seq) };
      server.serializeAttachment(a);
      const e = { ws: server, a };
      this.idx.set(uid, e);
      this.byWs.set(server, e);
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' } });
    }

    if (request.method === 'POST' && url.endsWith('/rename')) {
      const { uid, name } = await request.json();
      const rec = this.cache.get(uid);
      if (rec) rec.name = name;
      const e = this.index().get(uid);
      if (e) {
        e.a.name = name;
        e.ws.serializeAttachment(e.a);
        if (e.a.pid) this.broadcast({ t: 'rename', pid: e.a.pid, name, gname: e.a.gname || '' });
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && url.endsWith('/kick')) {
      const { uid } = await request.json();
      this.cache.delete(uid);
      const e = this.index().get(uid);
      if (e) this.kill(e, 4002, 'revoked');
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  // ---- WebSocket handlers (hibernation API) ----
  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const e = m && this.entryOf(ws);
    if (!e) return;
    const att = e.a;
    att.seen = Date.now();                              // in memory only; pings are timestamped by the runtime

    switch (m.t) {
      case 'hello': {
        const pid = String(m.pid ?? '');
        const gname = typeof m.gname === 'string' && m.gname.length <= 32 ? m.gname : '';
        if (!PID_RE.test(pid)) { this.send(ws, { t: 'err', code: 'bad_pid' }); return; }
        const holder = this.pids.get(pid);
        if (holder !== undefined && holder !== att.uid) { this.send(ws, { t: 'err', code: 'pid_taken' }); return; } // first claim wins
        if (att.pid && att.pid !== pid) { this.pids.delete(att.pid); this.broadcast({ t: 'leave', pid: att.pid }, e); }
        att.pid = pid;
        att.gname = gname;
        this.pids.set(pid, att.uid);
        ws.serializeAttachment(att);
        this.send(ws, { t: 'roster', players: this.roster() });
        this.broadcast({ t: 'join', pid, name: att.name, gname }, e);
        return;
      }
      case 'bye':
        if (att.pid) {
          this.pids.delete(att.pid);
          this.broadcast({ t: 'leave', pid: att.pid }, e);
          att.pid = null; att.gname = '';
          ws.serializeAttachment(att);
        }
        return;
      case 'lookup': {
        const ids = Array.isArray(m.ids) ? m.ids : [];
        const names = {};
        for (let i = 0; i < ids.length && i < 50; i++) {
          const id = String(ids[i]);
          const o = this.idx.get(this.pids.get(id));
          if (o) names[id] = { name: o.a.name, gname: o.a.gname || '' };
        }
        this.send(ws, { t: 'names', names });
        return;
      }
    }
  }

  webSocketClose(ws) {
    const e = this.entryOf(ws);
    if (e) { this.release(e, false); this.idx.delete(e.a.uid); }
    try { ws.close(1000, 'bye'); } catch {}
  }
  webSocketError(ws) {
    const e = this.entryOf(ws);
    if (e) { this.release(e, false); this.idx.delete(e.a.uid); }
  }

  async alarm() {
    const now = Date.now();
    const live = [];
    for (const e of this.index().values()) {
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(e.ws);
      const last = Math.max(e.a.seen || 0, auto ? auto.getTime() : 0);
      if (now - last > TIMEOUT_MS) this.kill(e, 4001, 'timeout');
      else live.push(e);
    }
    // Alarm instances are recreated after hibernation, so an in-memory timestamp is not durable.
    // Revalidate on every active-room sweep so bans and token-version bumps eventually take effect.
    if (live.length) await this.revalidate(live);
    if (this.idx.size) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async revalidate(entries) {
    const rows = new Map();
    for (let i = 0; i < entries.length; i += CHUNK) {
      const part = entries.slice(i, i + CHUNK);
      const ids = part.map((e) => e.a.uid);
      const res = await this.env.DB
        .prepare(`SELECT id,username,token_version,banned FROM users WHERE id IN (${ph(ids.length)})`)
        .bind(...ids).all();
      for (const r of res.results) rows.set(r.id, r);
    }
    for (const e of entries) {
      const a = e.a;
      const r = rows.get(a.uid);
      if (!r || r.banned || r.token_version !== a.tv) { this.kill(e, 4002, 'revoked'); continue; }
      this.putRec(a.uid, r.username, r.token_version, false);
      if (r.username !== a.name) {
        a.name = r.username;
        e.ws.serializeAttachment(a);
        if (a.pid) this.broadcast({ t: 'rename', pid: a.pid, name: a.name, gname: a.gname || '' });
      }
    }
  }

  // ---- helpers ----
  roster() {
    const out = [];
    for (const e of this.idx.values()) {
      if (e.a.pid) out.push({ pid: e.a.pid, name: e.a.name, gname: e.a.gname || '' });
    }
    return out;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);                      // serialized once, sent to everyone
    for (const e of this.index().values()) {
      if (e === except) continue;
      try { e.ws.send(s); } catch {}
    }
  }
  // Free the player id and tell the room; optionally persist the cleared attachment.
  release(e, persist = true) {
    const a = e.a;
    if (!a.pid) return;
    this.pids.delete(a.pid);
    this.broadcast({ t: 'leave', pid: a.pid }, e);
    a.pid = null; a.gname = '';
    if (persist) { try { e.ws.serializeAttachment(a); } catch {} }
  }
  kill(e, code, reason) {
    this.release(e, false);
    this.idx.delete(e.a.uid);
    try { e.ws.close(code, reason); } catch {}
  }
}
