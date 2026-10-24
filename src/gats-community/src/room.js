// Durable Objects.
//  Room: one per gats server. Hibernating WebSockets. Per-socket state lives in the socket
//        attachment (survives hibernation); no SQLite writes. D1 is read only as a fallback.
//  Gate: one per client IP. In-memory sliding-window throttle for /login /register /rename.

import { DurableObject } from 'cloudflare:workers';

const TIMEOUT_MS = 90_000;   // drop sockets silent for this long
const ALARM_MS = 60_000;     // sweep interval while anyone is connected
const CACHE_TTL = 300_000;
const PID_RE = /^[A-Za-z0-9_-]{1,12}$/;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cache = new Map(); // uid -> { name, tv, banned, at }  (hot, lost on eviction: rebuilt from D1)
    // "ping" -> "pong" is answered by the runtime WITHOUT waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async userRec(uid) {
    const c = this.cache.get(uid);
    if (c && Date.now() - c.at < CACHE_TTL) return c;
    const row = await this.env.DB.prepare('SELECT username,token_version,banned FROM users WHERE id=?1').bind(uid).first();
    if (!row) { this.cache.delete(uid); return null; }
    if (this.cache.size > 2000) this.cache.clear();
    const rec = { name: row.username, tv: row.token_version, banned: !!row.banned, at: Date.now() };
    this.cache.set(uid, rec);
    return rec;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const uid = request.headers.get('x-uid');
      const tv = Number(request.headers.get('x-tv'));
      const rec = uid ? await this.userRec(uid) : null;
      if (!rec || rec.banned || rec.tv !== tv) return new Response('revoked', { status: 401 });

      // one live presence socket per account per room
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.uid === uid) { this.drop(ws); try { ws.close(4000, 'replaced'); } catch {} }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ uid, name: rec.name, tv, pid: null, seen: Date.now() });
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' } });
    }

    if (request.method === 'POST' && url.pathname === '/rename') {
      const { uid, name } = await request.json();
      const rec = this.cache.get(uid);
      if (rec) rec.name = name;
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.uid === uid) {
          a.name = name; ws.serializeAttachment(a);
          if (a.pid) this.broadcast({ t: 'rename', pid: a.pid, name });
        }
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/kick') {
      const { uid } = await request.json();
      this.cache.delete(uid);
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.uid === uid) { this.drop(ws); try { ws.close(4002, 'revoked'); } catch {} }
      }
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  // ---- WebSocket handlers (hibernation API) ----
  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment();
    if (!att || !m) return;
    att.seen = Date.now();

    switch (m.t) {
      case 'hello': {
        const pid = String(m.pid ?? '');
        if (!PID_RE.test(pid)) { this.send(ws, { t: 'err', code: 'bad_pid' }); break; }
        const taken = this.ctx.getWebSockets().some((o) => {
          if (o === ws) return false;
          const a = o.deserializeAttachment();
          return a && a.pid === pid;
        });
        if (taken) { this.send(ws, { t: 'err', code: 'pid_taken' }); break; } // first claim wins
        if (att.pid && att.pid !== pid) this.broadcast({ t: 'leave', pid: att.pid }, ws);
        att.pid = pid;
        ws.serializeAttachment(att);
        this.send(ws, { t: 'roster', players: this.roster() });
        this.broadcast({ t: 'join', pid, name: att.name }, ws);
        return;
      }
      case 'bye':
        if (att.pid) { this.broadcast({ t: 'leave', pid: att.pid }, ws); att.pid = null; }
        break;
      case 'lookup': {
        const want = new Set((Array.isArray(m.ids) ? m.ids : []).slice(0, 50).map(String));
        const names = {};
        for (const o of this.ctx.getWebSockets()) {
          const a = o.deserializeAttachment();
          if (a && a.pid && want.has(a.pid)) names[a.pid] = a.name;
        }
        this.send(ws, { t: 'names', names });
        break;
      }
    }
    ws.serializeAttachment(att);
  }

  webSocketClose(ws) { this.drop(ws); try { ws.close(1000, 'bye'); } catch {} }
  webSocketError(ws) { this.drop(ws); }

  async alarm() {
    const now = Date.now();
    let live = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a ? a.seen : 0, auto ? auto.getTime() : 0);
      if (!a || now - last > TIMEOUT_MS) { this.drop(ws); try { ws.close(4001, 'timeout'); } catch {} }
      else live.push(ws);
    }
    // Alarm instances are recreated after hibernation, so an in-memory timestamp is not durable.
    // Revalidate on every active-room sweep so bans and token-version bumps eventually take effect.
    if (live.length) await this.revalidate(live);
    if (live.length) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async revalidate(socks) {
    const uids = [...new Set(socks.map((w) => w.deserializeAttachment().uid))];
    const rows = new Map();
    for (let i = 0; i < uids.length; i += 80) {
      const chunk = uids.slice(i, i + 80);
      const q = `SELECT id,username,token_version,banned FROM users WHERE id IN (${chunk.map((_, j) => '?' + (j + 1)).join(',')})`;
      const res = await this.env.DB.prepare(q).bind(...chunk).all();
      for (const r of res.results) rows.set(r.id, r);
    }
    for (const ws of socks) {
      const a = ws.deserializeAttachment();
      const r = rows.get(a.uid);
      if (!r || r.banned || r.token_version !== a.tv) { this.drop(ws); try { ws.close(4002, 'revoked'); } catch {} continue; }
      this.cache.set(a.uid, { name: r.username, tv: r.token_version, banned: false, at: Date.now() });
      if (r.username !== a.name) {
        a.name = r.username; ws.serializeAttachment(a);
        if (a.pid) this.broadcast({ t: 'rename', pid: a.pid, name: a.name });
      }
    }
  }

  // ---- helpers ----
  roster() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.pid) out.push({ pid: a.pid, name: a.name });
    }
    return out;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }
  drop(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.pid) { this.broadcast({ t: 'leave', pid: a.pid }, ws); a.pid = null; try { ws.serializeAttachment(a); } catch {} }
  }
}

export class Gate extends DurableObject {
  hits = [];
  async fetch() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 10 * 60_000);
    if (this.hits.length >= 10) return new Response('slow down', { status: 429 });
    this.hits.push(now);
    return new Response('ok');
  }
}
