// index.js — login-info-handler (Cloudflare Worker). Stateless front door.
//
//   POST /signup       create account, returns a token
//   POST /login/salt   returns the per-user salt the client needs for PBKDF2
//   POST /login        verify client-hashed password, returns a token
//   POST /rename       change display name (Bearer token), tells the room DO live
//   POST /unregister   delete account (Bearer token + password)
//   GET  /presence     WebSocket upgrade, verified here, forwarded to the room DO
//
// Bindings (see wrangler.toml): DB (D1), ROOM (Durable Object), AUTH_SECRET (secret),
// RL_AUTH / RL_SIGNUP (optional rate-limit bindings).

import {
  USERNAME_RE, SALT_RE, PH_RE, ROOM_RE,
  DEFAULT_KDF_ITER, MIN_KDF_ITER, MAX_KDF_ITER,
  nowSec, safeEqual, pwHash, fakeSalt, signToken, verifyToken, json, intVar,
} from './lib.js';

export { PresenceRoom } from './room.js';

const MAX_FAILS = 5;          // wrong passwords before a lockout
const LOCK_SECONDS = 900;     // lockout length (15 min)

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('unhandled', e && e.stack ? e.stack : e);
      return json(500, { ok: false, error: 'server_error' });
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/presence') return handlePresence(request, env, url);

  const routes = {
    '/signup': handleSignup,
    '/login/salt': handleSalt,
    '/login': handleLogin,
    '/rename': handleRename,
    '/unregister': handleUnregister,
  };
  const handler = routes[path];
  if (!handler) return json(404, { ok: false, error: 'not_found' });
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  return handler(request, env, ctx);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function rateLimited(env, binding, request) {
  const rl = env[binding];
  if (!rl) return false; // binding missing -> no limiting (still works)
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await rl.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}

async function readBody(request) {
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > 4096) throw new HttpError(413, 'too_large');
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, 'too_large');
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json');
  return body;
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function withErrors(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof HttpError) return json(e.status, { ok: false, error: e.code });
    throw e;
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

function ttlSeconds(env) {
  return intVar(env, 'TOKEN_TTL_DAYS', 30) * 86400;
}

async function issue(env, user) {
  const { token, exp } = await signToken(env, user, ttlSeconds(env));
  return { ok: true, token, exp, user: { id: user.id, username: user.username } };
}

// Verify token signature + expiry (no DB), then load the row and check the
// token version / ban flag (one D1 read). Used by calls that touch D1 anyway.
async function authedUser(request, env) {
  const tok = await verifyToken(env, bearer(request));
  if (!tok) throw new HttpError(401, 'bad_token');
  const row = await env.DB.prepare(
    'SELECT id, username, pw_hash, banned, token_version, renamed_at, fail_count, locked_until FROM users WHERE id = ?1'
  ).bind(tok.u).first();
  if (!row || row.token_version !== tok.v) throw new HttpError(401, 'revoked');
  if (row.banned) throw new HttpError(403, 'banned');
  return { tok, row };
}

async function recordFailure(env, id, now) {
  await env.DB.prepare(
    `UPDATE users SET
       fail_count   = CASE WHEN fail_count + 1 >= ?1 THEN 0 ELSE fail_count + 1 END,
       locked_until = CASE WHEN fail_count + 1 >= ?1 THEN ?2 ELSE locked_until END
     WHERE id = ?3`
  ).bind(MAX_FAILS, now + LOCK_SECONDS, id).run();
}

// ---------------------------------------------------------------------------
// POST /signup
// ---------------------------------------------------------------------------
function handleSignup(request, env) {
  return withErrors(async () => {
    if (await rateLimited(env, 'RL_SIGNUP', request)) throw new HttpError(429, 'rate_limited');
    const b = await readBody(request);
    const username = str(b.username), salt = str(b.salt), ph = str(b.ph);
    const iter = Number(b.iter);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'bad_username');
    if (!SALT_RE.test(salt) || !PH_RE.test(ph)) throw new HttpError(400, 'bad_request');
    if (!Number.isInteger(iter) || iter < MIN_KDF_ITER || iter > MAX_KDF_ITER) {
      throw new HttpError(400, 'bad_request');
    }

    const now = nowSec();
    let res;
    try {
      res = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (username, username_lower, salt, kdf_iter, pw_hash, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(username, username.toLowerCase(), salt, iter, await pwHash(ph), now),
        env.DB.prepare(
          `INSERT INTO events (ts, user_id, type) VALUES (?1, last_insert_rowid(), 'signup')`
        ).bind(now),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, 'username_taken');
      throw e;
    }
    const id = res[0].meta.last_row_id;
    return json(201, await issue(env, { id, username, ver: 1 }));
  });
}

// ---------------------------------------------------------------------------
// POST /login/salt   (step 1 of login: client needs the salt to run PBKDF2)
// ---------------------------------------------------------------------------
function handleSalt(request, env) {
  return withErrors(async () => {
    if (await rateLimited(env, 'RL_AUTH', request)) throw new HttpError(429, 'rate_limited');
    const b = await readBody(request);
    const username = str(b.username);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'bad_username');
    const lower = username.toLowerCase();
    const row = await env.DB.prepare(
      'SELECT salt, kdf_iter FROM users WHERE username_lower = ?1'
    ).bind(lower).first();
    if (row) return json(200, { ok: true, salt: row.salt, iter: row.kdf_iter });
    return json(200, { ok: true, salt: await fakeSalt(env, lower), iter: DEFAULT_KDF_ITER });
  });
}

// ---------------------------------------------------------------------------
// POST /login   (step 2: client sends PBKDF2 output, never the password)
// ---------------------------------------------------------------------------
function handleLogin(request, env) {
  return withErrors(async () => {
    if (await rateLimited(env, 'RL_AUTH', request)) throw new HttpError(429, 'rate_limited');
    const b = await readBody(request);
    const username = str(b.username), ph = str(b.ph);
    if (!USERNAME_RE.test(username) || !PH_RE.test(ph)) throw new HttpError(401, 'invalid_credentials');

    const now = nowSec();
    const attempt = await pwHash(ph); // computed up front so unknown users cost the same
    const row = await env.DB.prepare(
      `SELECT id, username, pw_hash, banned, token_version, fail_count, locked_until
         FROM users WHERE username_lower = ?1`
    ).bind(username.toLowerCase()).first();

    if (!row) throw new HttpError(401, 'invalid_credentials');
    if (row.locked_until > now) {
      return json(429, { ok: false, error: 'locked', retry_after: row.locked_until - now });
    }
    if (!safeEqual(attempt, row.pw_hash)) {
      await recordFailure(env, row.id, now);
      throw new HttpError(401, 'invalid_credentials');
    }
    if (row.banned) throw new HttpError(403, 'banned');

    // one logged write; the UPDATE is a no-op unless there was a failure streak
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE users SET fail_count = 0, locked_until = 0 WHERE id = ?1 AND (fail_count > 0 OR locked_until > 0)'
      ).bind(row.id),
      env.DB.prepare(`INSERT INTO events (ts, user_id, type) VALUES (?1, ?2, 'login')`).bind(now, row.id),
    ]);
    return json(200, await issue(env, { id: row.id, username: row.username, ver: row.token_version }));
  });
}

// ---------------------------------------------------------------------------
// POST /rename   Authorization: Bearer <token>   body { name, room? }
// ---------------------------------------------------------------------------
function handleRename(request, env, ctx) {
  return withErrors(async () => {
    const { tok, row } = await authedUser(request, env);
    const b = await readBody(request);
    const name = str(b.name);
    const room = str(b.room);
    if (!USERNAME_RE.test(name)) throw new HttpError(400, 'bad_username');

    const now = nowSec();
    if (name === row.username) {
      return json(200, await issue(env, { id: row.id, username: row.username, ver: row.token_version }));
    }
    const cooldown = intVar(env, 'RENAME_COOLDOWN_SECONDS', 86400);
    if (row.renamed_at + cooldown > now) {
      return json(429, { ok: false, error: 'cooldown', retry_after: row.renamed_at + cooldown - now });
    }

    let res;
    try {
      res = await env.DB.batch([
        // guarded: only applies if nothing changed since we read the row
        env.DB.prepare(
          `UPDATE users SET username = ?1, username_lower = ?2, renamed_at = ?3
            WHERE id = ?4 AND token_version = ?5 AND banned = 0 AND renamed_at = ?6`
        ).bind(name, name.toLowerCase(), now, row.id, row.token_version, row.renamed_at),
        // append-only history, only if the UPDATE actually changed a row
        env.DB.prepare(
          `INSERT INTO events (ts, user_id, type, detail)
           SELECT ?1, ?2, 'rename', ?3 WHERE changes() > 0`
        ).bind(now, row.id, JSON.stringify({ from: row.username, to: name })),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, 'username_taken');
      throw e;
    }
    if (res[0].meta.changes !== 1) throw new HttpError(409, 'conflict');

    if (ROOM_RE.test(room)) ctx.waitUntil(notifyRoom(env, room, { uid: row.id, name }));
    return json(200, await issue(env, { id: row.id, username: name, ver: row.token_version }));
  });
}

async function notifyRoom(env, room, payload) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    await stub.fetch('https://room/rename', {
      method: 'POST',
      headers: { 'x-gcl-internal': '1', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('notifyRoom failed', e);
  }
}

// ---------------------------------------------------------------------------
// POST /unregister   Authorization: Bearer <token>   body { ph }
// ---------------------------------------------------------------------------
function handleUnregister(request, env) {
  return withErrors(async () => {
    const { row } = await authedUser(request, env);
    const b = await readBody(request);
    const ph = str(b.ph);
    if (!PH_RE.test(ph)) throw new HttpError(400, 'bad_request');
    const now = nowSec();
    if (row.locked_until > now) {
      return json(429, { ok: false, error: 'locked', retry_after: row.locked_until - now });
    }
    if (!safeEqual(await pwHash(ph), row.pw_hash)) {
      await recordFailure(env, row.id, now);
      throw new HttpError(401, 'invalid_credentials');
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (ts, user_id, type, detail) VALUES (?1, ?2, 'unregister', ?3)`
      ).bind(now, row.id, JSON.stringify({ username: row.username })),
      env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(row.id),
    ]);
    return json(200, { ok: true });
  });
}

// ---------------------------------------------------------------------------
// GET /presence?room=<host[:port]>   (WebSocket)
// The token rides in Sec-WebSocket-Protocol: "gcl.v1, <token>" because browsers
// can't set Authorization on a WebSocket and query strings end up in logs.
// Auth failures are reported as WebSocket close codes (4401) so the userscript
// can tell "token rejected" from "network down".
// ---------------------------------------------------------------------------
async function handlePresence(request, env, url) {
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return json(426, { ok: false, error: 'upgrade_required' });
  }
  const room = url.searchParams.get('room') || '';
  if (!ROOM_RE.test(room)) return json(400, { ok: false, error: 'bad_room' });

  const protos = (request.headers.get('sec-websocket-protocol') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!protos.includes('gcl.v1')) return json(400, { ok: false, error: 'bad_protocol' });
  const token = protos.find((p) => p !== 'gcl.v1');

  const payload = token ? await verifyToken(env, token) : null;
  if (!payload) return denyWs(4401, 'bad_token');

  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('x-gcl-')) headers.delete(k);
  headers.set('sec-websocket-protocol', 'gcl.v1'); // the token never reaches the DO
  headers.set('x-gcl-uid', String(payload.u));
  headers.set('x-gcl-ver', String(payload.v));
  headers.set('x-gcl-room', room);

  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  return stub.fetch(new Request('https://room/presence', { method: 'GET', headers }));
}

function denyWs(code, reason) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.close(code, reason);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { 'Sec-WebSocket-Protocol': 'gcl.v1' },
  });
}
