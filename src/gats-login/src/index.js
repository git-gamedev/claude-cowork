// login-info-handler: stateless front door. Routes requests, signs/verifies tokens,
// talks to D1 for durable data and to Durable Objects for hot state.

import {
  LIMITS, RE, isReserved, cors, json, readJson, safeEqual,
  signToken, verifyToken, pwHash, fakeSalt, randomHex, ipHash,
} from './lib.js';

export { PresenceRoom } from './presence-room.js';
export { AuthCache } from './auth-cache.js';

// ---------- internal helpers ----------

async function authCall(env, path, body) {
  const stub = env.AUTH.get(env.AUTH.idFromName('global'));
  const res = await stub.fetch('https://auth.internal' + path, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Signature + expiry are checked locally (no DB). Revocation / ban / current name come from AuthCache.
async function authenticate(request, env, token = bearer(request), room) {
  const p = await verifyToken(env, token);
  if (!p) return { error: 'bad_token' };
  const r = await authCall(env, '/check', { uid: p.uid, tv: p.tv, room });
  if (!r.ok) return { error: r.reason || 'revoked' };
  return { uid: p.uid, tv: p.tv, name: r.name };
}

function authFail(request, a) {
  return json(request, { error: a.error }, a.error === 'banned' ? 403 : 401);
}

async function issue(env, uid, name, tv) {
  const days = Number(env.TOKEN_TTL_DAYS) || 7;
  const now = Date.now();
  const exp = now + days * 86400000;
  const token = await signToken(env, { uid, name, tv, iat: now, exp });
  return { token, expiresAt: exp, user: { id: uid, username: name } };
}

function isUnique(e) {
  return String((e && e.message) || e).includes('UNIQUE');
}

function logEvent(env, userId, type, detail, ip) {
  return env.DB.prepare('INSERT INTO events (ts, user_id, type, detail, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), userId, type, detail ?? null, ip ?? null);
}

// Password check with per-account lockout. `row` is a full users row.
async function verifyPassword(env, row, key) {
  const now = Date.now();
  if (row.locked_until > now) return { ok: false, locked: true, retryAfter: Math.ceil((row.locked_until - now) / 1000) };
  if (safeEqual(await pwHash(env, key), row.pw_hash)) return { ok: true };
  const fails = row.failed_count + 1;
  const lock = fails >= LIMITS.LOCK_AFTER;
  await env.DB.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?')
    .bind(lock ? 0 : fails, lock ? now + LIMITS.LOCK_MS : 0, row.id).run();
  return { ok: false };
}

// ---------- route handlers ----------

async function prelogin(request, env) {
  const b = await readJson(request);
  const username = b && b.username;
  if (typeof username !== 'string' || !RE.username.test(username)) return json(request, { error: 'bad_username' }, 400);
  const lc = username.toLowerCase();
  const row = await env.DB.prepare('SELECT salt, iter FROM users WHERE username_lc = ?').bind(lc).first();
  if (row) return json(request, { salt: row.salt, iter: row.iter });
  return json(request, { salt: await fakeSalt(env, lc), iter: LIMITS.DEFAULT_ITER });
}

async function signup(request, env) {
  const b = await readJson(request);
  if (!b) return json(request, { error: 'bad_request' }, 400);
  const { username, salt, iter, key } = b;
  if (typeof username !== 'string' || !RE.username.test(username)) return json(request, { error: 'bad_username' }, 400);
  if (!RE.salt.test(salt || '') || !RE.key.test(key || '')) return json(request, { error: 'bad_request' }, 400);
  if (!Number.isInteger(iter) || iter < LIMITS.MIN_ITER || iter > LIMITS.MAX_ITER) return json(request, { error: 'bad_iter' }, 400);
  const lc = username.toLowerCase();
  if (isReserved(lc)) return json(request, { error: 'name_taken' }, 409);

  const ip = await ipHash(request, env);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'signup' AND ip_hash = ? AND ts > ?")
    .bind(ip, Date.now() - 3600000).first();
  if (recent && recent.c >= LIMITS.SIGNUPS_PER_IP_PER_HOUR) return json(request, { error: 'rate_limited' }, 429);

  const id = randomHex(16);
  const now = Date.now();
  const pw = await pwHash(env, key);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, username, username_lc, salt, iter, pw_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, username, lc, salt, iter, pw, now, now),
      logEvent(env, id, 'signup', null, ip),
    ]);
  } catch (e) {
    if (isUnique(e)) return json(request, { error: 'name_taken' }, 409);
    throw e;
  }
  return json(request, await issue(env, id, username, 1), 201);
}

async function login(request, env) {
  const b = await readJson(request);
  if (!b || typeof b.username !== 'string' || !RE.username.test(b.username) || !RE.key.test(b.key || '')) {
    return json(request, { error: 'bad_request' }, 400);
  }
  const lc = b.username.toLowerCase();
  const row = await env.DB.prepare('SELECT * FROM users WHERE username_lc = ?').bind(lc).first();
  if (!row) {
    await pwHash(env, b.key); // keep timing similar for unknown names
    return json(request, { error: 'invalid_credentials' }, 401);
  }
  const v = await verifyPassword(env, row, b.key);
  if (v.locked) return json(request, { error: 'locked', retryAfter: v.retryAfter }, 429);
  if (!v.ok) return json(request, { error: 'invalid_credentials' }, 401);
  if (row.banned) return json(request, { error: 'banned', reason: row.ban_reason || null }, 403);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET failed_count = 0, locked_until = 0, last_login_at = ? WHERE id = ?').bind(now, row.id),
    logEvent(env, row.id, 'login', null, await ipHash(request, env)),
  ]);
  return json(request, await issue(env, row.id, row.username, row.token_version));
}

async function refresh(request, env) {
  const a = await authenticate(request, env);
  if (a.error) return authFail(request, a);
  return json(request, await issue(env, a.uid, a.name, a.tv));
}

async function rename(request, env) {
  const a = await authenticate(request, env);
  if (a.error) return authFail(request, a);
  const b = await readJson(request);
  const username = b && b.username;
  if (typeof username !== 'string' || !RE.username.test(username)) return json(request, { error: 'bad_username' }, 400);
  const lc = username.toLowerCase();
  if (isReserved(lc)) return json(request, { error: 'name_taken' }, 409);

  const row = await env.DB.prepare('SELECT username, renamed_at FROM users WHERE id = ?').bind(a.uid).first();
  if (!row) return json(request, { error: 'gone' }, 401);
  const wait = row.renamed_at + LIMITS.RENAME_COOLDOWN_MS - Date.now();
  if (wait > 0) return json(request, { error: 'rename_cooldown', retryAfter: Math.ceil(wait / 1000) }, 429);

  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET username = ?, username_lc = ?, renamed_at = ? WHERE id = ?').bind(username, lc, Date.now(), a.uid),
      logEvent(env, a.uid, 'rename', JSON.stringify({ from: row.username, to: username }), await ipHash(request, env)),
    ]);
  } catch (e) {
    if (isUnique(e)) return json(request, { error: 'name_taken' }, 409);
    throw e;
  }
  // Drop the cached record and push the new name into the room the user is in.
  await authCall(env, '/invalidate', { uid: a.uid, action: 'rename', name: username });
  return json(request, await issue(env, a.uid, username, a.tv));
}

async function logoutAll(request, env) {
  const a = await authenticate(request, env);
  if (a.error) return authFail(request, a);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(a.uid),
    logEvent(env, a.uid, 'logout_all', null, await ipHash(request, env)),
  ]);
  await authCall(env, '/invalidate', { uid: a.uid, action: 'kick', reason: 'revoked' });
  return json(request, { ok: true });
}

async function unregister(request, env) {
  const a = await authenticate(request, env);
  if (a.error) return authFail(request, a);
  const b = await readJson(request);
  if (!b || !RE.key.test(b.key || '')) return json(request, { error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(a.uid).first();
  if (!row) return json(request, { error: 'gone' }, 401);
  const v = await verifyPassword(env, row, b.key);
  if (v.locked) return json(request, { error: 'locked', retryAfter: v.retryAfter }, 429);
  if (!v.ok) return json(request, { error: 'invalid_credentials' }, 401);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(a.uid),
    logEvent(env, a.uid, 'unregister', null, await ipHash(request, env)),
  ]);
  await authCall(env, '/invalidate', { uid: a.uid, action: 'kick', reason: 'deleted' });
  return json(request, { ok: true });
}

async function adminBan(request, env, ban) {
  if (!env.ADMIN_KEY) return json(request, { error: 'not_found' }, 404);
  if (!safeEqual(request.headers.get('X-Admin-Key') || '', env.ADMIN_KEY)) return json(request, { error: 'unauthorized' }, 401);
  const b = await readJson(request);
  if (!b || typeof b.username !== 'string') return json(request, { error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT id FROM users WHERE username_lc = ?').bind(b.username.toLowerCase()).first();
  if (!row) return json(request, { error: 'not_found' }, 404);
  const reason = ban ? String(b.reason || '').slice(0, 200) || null : null;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET banned = ?, ban_reason = ?, token_version = token_version + 1 WHERE id = ?').bind(ban ? 1 : 0, reason, row.id),
    logEvent(env, row.id, ban ? 'ban' : 'unban', reason, null),
  ]);
  await authCall(env, '/invalidate', { uid: row.id, action: ban ? 'kick' : 'drop', reason: 'banned' });
  return json(request, { ok: true });
}

async function presence(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') return json(request, { error: 'expected_websocket' }, 426);
  const room = (url.searchParams.get('room') || '').toLowerCase();
  const suffix = (env.ALLOWED_ROOM_SUFFIX || 'gats.io').toLowerCase();
  const host = room.split(':')[0];
  if (!RE.room.test(room) || !(host === suffix || host.endsWith('.' + suffix))) return json(request, { error: 'bad_room' }, 400);

  // Browsers cannot set Authorization on a WebSocket, so the token rides in the subprotocol list.
  const protos = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  const tok = protos.find((p) => p.startsWith('tok.'));
  const a = await authenticate(request, env, tok ? tok.slice(4) : null, room);
  if (a.error) return authFail(request, a);

  // Forward to the room's Durable Object. The token is stripped; identity is passed in trusted headers.
  const headers = new Headers(request.headers);
  headers.set('X-GCL-Uid', a.uid);
  headers.set('X-GCL-Name', a.name);
  headers.set('Sec-WebSocket-Protocol', 'gcl.v1');
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  return stub.fetch(new Request(request, { headers }));
}

// ---------- entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    if (!env.TOKEN_SECRET || !env.PEPPER) return json(request, { error: 'misconfigured' }, 500);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /': return json(request, { ok: true, service: 'gats-login' });
        case 'POST /prelogin': return await prelogin(request, env);
        case 'POST /signup': return await signup(request, env);
        case 'POST /login': return await login(request, env);
        case 'POST /refresh': return await refresh(request, env);
        case 'POST /rename': return await rename(request, env);
        case 'POST /logout_all': return await logoutAll(request, env);
        case 'POST /unregister': return await unregister(request, env);
        case 'GET /presence': return await presence(request, env, url);
        case 'POST /admin/ban': return await adminBan(request, env, true);
        case 'POST /admin/unban': return await adminBan(request, env, false);
        default: return json(request, { error: 'not_found' }, 404);
      }
    } catch (e) {
      console.error((e && e.stack) || e);
      return json(request, { error: 'server_error' }, 500);
    }
  },
};
