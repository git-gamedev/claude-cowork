// PresenceRoom: one Durable Object per game server (named after its host).
// Hibernating WebSockets: state lives in memory and in each socket's attachment, so the
// object can sleep between messages and rebuild itself on wake. No SQLite/D1 here.
//
// Client -> room (JSON text)           Room -> client
//   "ping" (auto-answered "pong")        {t:"roster", online, players:{gid:{name,gname}}}
//   {t:"claim", gid, gname}              {t:"join", gid, name, gname}
//   {t:"release"}                        {t:"leave", gid}
//   {t:"lookup", ids:[gid,...]}          {t:"rename", gid, name}
//                                        {t:"names", players:{gid:{name,gname,seen}}}
//                                        {t:"denied", gid}
//                                        {t:"kick", reason}

const MAX_MSG = 600;
const STALE_MS = 120000;
const GID_RE = /^[A-Za-z0-9_-]{1,12}$/;

export class PresenceRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Answered by the runtime without waking the object; also stamps last-seen per socket.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.claims = new Map();   // gid -> ws
    this.rates = new WeakMap();
    for (const ws of ctx.getWebSockets()) {
      const a = this.info(ws);
      if (a.gid) this.claims.set(a.gid, ws);
    }
  }

  info(ws) {
    return ws.deserializeAttachment() || {};
  }

  roster() {
    const out = {};
    for (const [gid, ws] of this.claims) {
      const a = this.info(ws);
      out[gid] = { name: a.name, gname: a.gname };
    }
    return out;
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch { /* socket is closing */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_rename' || url.pathname === '/_kick') {
      return this.internal(url.pathname, await request.json());
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const uid = request.headers.get('X-GCL-Uid');
    const name = request.headers.get('X-GCL-Name');
    if (!uid || !name) return new Response('forbidden', { status: 403 });

    // One live socket per account per room: a newer connection replaces the older one.
    for (const ws of this.ctx.getWebSockets()) {
      if (this.info(ws).uid === uid) this.drop(ws, 'replaced');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, name, gid: null, gname: null, since: Date.now() });
    server.send(JSON.stringify({ t: 'roster', online: this.ctx.getWebSockets().length, players: this.roster() }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' } });
  }

  internal(path, body) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.info(ws);
      if (a.uid !== body.uid) continue;
      if (path === '/_rename' && typeof body.name === 'string') {
        a.name = body.name;
        ws.serializeAttachment(a);
        if (a.gid) this.broadcast({ t: 'rename', gid: a.gid, name: a.name });
      } else if (path === '/_kick') {
        this.drop(ws, String(body.reason || 'revoked'));
      }
    }
    return Response.json({ ok: true });
  }

  allow(ws) {
    const now = Date.now();
    const r = this.rates.get(ws) || { n: 0, t: now };
    if (now - r.t > 10000) { r.n = 0; r.t = now; }
    r.n++;
    this.rates.set(ws, r);
    return r.n <= 30;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MSG) return;
    if (!this.allow(ws)) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'claim') return this.onClaim(ws, m);
    if (m.t === 'release') return this.releaseClaim(ws);
    if (m.t === 'lookup' && Array.isArray(m.ids)) {
      const players = {};
      for (const gid of m.ids.slice(0, 50)) {
        if (typeof gid !== 'string') continue;
        const target = this.claims.get(gid);
        if (!target) continue;
        const a = this.info(target);
        const ts = this.ctx.getWebSocketAutoResponseTimestamp(target);
        players[gid] = { name: a.name, gname: a.gname, seen: ts ? ts.getTime() : a.since };
      }
      ws.send(JSON.stringify({ t: 'names', players }));
    }
  }

  onClaim(ws, m) {
    const gid = typeof m.gid === 'string' ? m.gid : '';
    const gname = typeof m.gname === 'string' ? m.gname.replace(/[\u0000-\u001f]/g, '').slice(0, 32) : '';
    if (!GID_RE.test(gid)) return;

    // Drop sockets that stopped pinging without closing cleanly.
    const now = Date.now();
    for (const other of this.ctx.getWebSockets()) {
      const ts = this.ctx.getWebSocketAutoResponseTimestamp(other);
      if (other !== ws && ts && now - ts.getTime() > STALE_MS) this.drop(other, 'stale');
    }

    const existing = this.claims.get(gid);
    if (existing && existing !== ws) {
      ws.send(JSON.stringify({ t: 'denied', gid })); // first claim wins while that socket is alive
      return;
    }
    this.releaseClaim(ws);
    const a = this.info(ws);
    a.gid = gid;
    a.gname = gname;
    ws.serializeAttachment(a);
    this.claims.set(gid, ws);
    this.broadcast({ t: 'join', gid, name: a.name, gname }, ws);
  }

  releaseClaim(ws) {
    const a = this.info(ws);
    if (!a.gid) return;
    if (this.claims.get(a.gid) === ws) {
      this.claims.delete(a.gid);
      this.broadcast({ t: 'leave', gid: a.gid }, ws);
    }
    a.gid = null;
    a.gname = null;
    try { ws.serializeAttachment(a); } catch { /* already closed */ }
  }

  drop(ws, reason) {
    this.releaseClaim(ws);
    try {
      ws.send(JSON.stringify({ t: 'kick', reason }));
      ws.close(4000, reason.slice(0, 100));
    } catch { /* already closed */ }
  }

  async webSocketClose(ws, code) {
    this.releaseClaim(ws);
    const ok = code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code);
    try { ws.close(ok ? code : 1000, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    this.releaseClaim(ws);
  }
}
