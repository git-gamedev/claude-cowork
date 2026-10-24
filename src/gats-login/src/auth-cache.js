// AuthCache: one global Durable Object that answers "is this token still good?" from memory.
//   - Cache miss or entry older than TTL -> ONE D1 read, then cached (the DO -> D1 fallback arrow).
//   - Remembers which room each user last joined (tiny KV write only when it changes), so rename/ban
//     can be pushed live into the right PresenceRoom.

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

export class AuthCache {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.users = new Map(); // uid -> { name, tv, banned, gone, at }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    if (url.pathname === '/check') return Response.json(await this.check(body));
    if (url.pathname === '/invalidate') return Response.json(await this.invalidate(body));
    return new Response('not found', { status: 404 });
  }

  async check({ uid, tv, room }) {
    let rec = this.users.get(uid);
    if (!rec || Date.now() - rec.at > TTL_MS) {
      const row = await this.env.DB
        .prepare('SELECT username, token_version, banned FROM users WHERE id = ?')
        .bind(uid).first();
      rec = row
        ? { name: row.username, tv: row.token_version, banned: !!row.banned, at: Date.now() }
        : { gone: true, at: Date.now() };
      if (this.users.size >= MAX_ENTRIES) this.users.clear();
      this.users.set(uid, rec);
    }
    if (rec.gone) return { ok: false, reason: 'gone' };
    if (rec.banned) return { ok: false, reason: 'banned' };
    if (rec.tv !== tv) return { ok: false, reason: 'revoked' };

    if (room) {
      const key = 'room:' + uid;
      if ((await this.ctx.storage.get(key)) !== room) await this.ctx.storage.put(key, room);
    }
    return { ok: true, name: rec.name };
  }

  // action: 'drop' (just forget), 'rename' (push new name to room), 'kick' (disconnect from room)
  async invalidate({ uid, action, name, reason }) {
    this.users.delete(uid);
    const key = 'room:' + uid;
    const room = await this.ctx.storage.get(key);
    if (room && (action === 'rename' || action === 'kick')) {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(room));
      const path = action === 'rename' ? '/_rename' : '/_kick';
      try {
        await stub.fetch('https://room.internal' + path, {
          method: 'POST',
          body: JSON.stringify({ uid, name, reason: reason || 'revoked' }),
        });
      } catch (e) {
        console.error('room notify failed', e && e.message);
      }
    }
    if (action === 'kick') await this.ctx.storage.delete(key);
    return { ok: true };
  }
}
