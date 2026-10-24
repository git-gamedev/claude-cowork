// login-info-handler: the stateless front door.
// Routes: POST /register /login /refresh /rename /logout-all /admin/ban
//         GET  /presence (WebSocket upgrade)   GET /health

import { signToken, verifyToken, sha256Hex, safeEqStr } from './lib.js';
import { gateOp } from './authgate.js';

export { Room } from './room.js';
export { AuthGate } from './authgate.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const ROOM_RE = /^[a-z0-9._:-]{1,64}$/;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'gats', 'staff', 'owner']);
const MAX_BODY = 4096;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large');
  let b;
  try { b = JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_json');
  return b;
}

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };

// ---- password gate (DO by default, in-Worker if HASH_MODE=worker) -----------

const localMem = new Map();
function shardOf(key) {
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 4;
}
async function gate(env, shardKey, body) {
  const iterations = Math.min(100000, Math.floor(num(env.PBKDF2_ITERATIONS, 100000)));
  if (env.HASH_MODE === 'worker') return gateOp(localMem, body, iterations);
  const stub = env.AUTHGATE.get(env.AUTHGATE.idFromName('gate-' + shardOf(shardKey)));
  const res = await stub.fetch('https://gate/', { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

// ---- tokens / events ----------------------------------------------------------

async function issueToken(env, user) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(num(env.TOKEN_TTL_DAYS, 7) * 86400);
  const token = await signToken(env.TOKEN_SECRET, { u: user.id, n: user.username, v: user.token_version, iat, exp });
  return { token, exp, user: { username: user.username } };
}

async function authed(req, env) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  return verifyToken(env.TOKEN_SECRET, h.slice(7).trim());
}

async function logEvent(env, req, userId, type, detail) {
  const ip = req.headers.get('cf-connecting-ip') || '';
  const ipHash = ip ? (await sha256Hex(env.TOKEN_SECRET + ip)).slice(0, 16) : null;
  await env.DB
    .prepare('INSERT INTO events (ts, user_id, type, detail, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), userId, type, detail ?? null, ipHash)
    .run();
}

function validName(name) {
  return USERNAME_RE.test(name) && !RESERVED.has(name.toLowerCase());
}

const isUnique = (e) => /UNIQUE/i.test(String((e && e.message) || e));

async function notifyRoom(env, room, path, payload) {
  try {
    if (typeof room !== 'string' || !ROOM_RE.test(room)) return;
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    await stub.fetch('https://room' + path, { method: 'POST', body: JSON.stringify(payload) });
  } catch (e) {
    console.error('notifyRoom failed', e);
  }
}

// ---- handlers ----------------------------------------------------------------------

async function register(req, env) {
  const b = await readJson(req);
  const username = String(b.username ?? '');
  const password = String(b.password ?? '');
  if (!validName(username)) throw new HttpError(400, 'invalid_username');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'invalid_password');
  const lc = username.toLowerCase();

  const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE username_lc = ?').bind(lc).first();
  if (exists) throw new HttpError(409, 'username_taken');

  const ip = req.headers.get('cf-connecting-ip') || '';
  const g = await gate(env, ip, { op: 'hash', password, ip });
  if (g.locked) throw new HttpError(429, 'rate_limited');

  const user = { id: crypto.randomUUID(), username, token_version: 1 };
  try {
    await env.DB
      .prepare('INSERT INTO users (id, username, username_lc, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, username, lc, g.hash, Date.now())
      .run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'username_taken');
    throw e;
  }
  await logEvent(env, req, user.id, 'register', username);
  return json(await issueToken(env, user), 201);
}

async function login(req, env) {
  const b = await readJson(req);
  const username = String(b.username ?? '');
  const password = String(b.password ?? '');
  if (username.length > 32 || password.length > 128 || !password) throw new HttpError(401, 'invalid_credentials');
  const lc = username.toLowerCase();

  const row = await env.DB
    .prepare('SELECT id, username, pw_hash, banned, ban_reason, token_version FROM users WHERE username_lc = ?')
    .bind(lc).first();

  const ip = req.headers.get('cf-connecting-ip') || '';
  const g = await gate(env, lc, { op: 'verify', user: lc, ip, password, stored: row ? row.pw_hash : null });
  if (g.locked) throw new HttpError(429, 'rate_limited');
  if (!g.ok || !row) throw new HttpError(401, 'invalid_credentials');
  if (row.banned) return json({ error: 'banned', reason: row.ban_reason || null }, 403);

  await logEvent(env, req, row.id, 'login', null);
  return json(await issueToken(env, row));
}

async function loadLiveUser(env, claims) {
  const row = await env.DB
    .prepare('SELECT id, username, banned, token_version, renamed_at FROM users WHERE id = ?')
    .bind(claims.u).first();
  if (!row || row.banned || row.token_version !== claims.v) return null;
  return row;
}

async function refresh(req, env) {
  const claims = await authed(req, env);
  if (!claims) throw new HttpError(401, 'invalid_token');
  const row = await loadLiveUser(env, claims);
  if (!row) throw new HttpError(401, 'invalid_token');
  return json(await issueToken(env, row));
}

async function rename(req, env) {
  const claims = await authed(req, env);
  if (!claims) throw new HttpError(401, 'invalid_token');
  const b = await readJson(req);
  const name = String(b.username ?? '');
  if (!validName(name)) throw new HttpError(400, 'invalid_username');

  const row = await loadLiveUser(env, claims);
  if (!row) throw new HttpError(401, 'invalid_token');
  if (row.username === name) throw new HttpError(400, 'unchanged');

  const cooldownMs = num(env.RENAME_COOLDOWN_HOURS, 24) * 3600 * 1000;
  if (row.renamed_at && Date.now() - row.renamed_at < cooldownMs) {
    return json({ error: 'cooldown', retry_after_s: Math.ceil((cooldownMs - (Date.now() - row.renamed_at)) / 1000) }, 429);
  }

  let res;
  try {
    res = await env.DB
      .prepare('UPDATE users SET username = ?, username_lc = ?, renamed_at = ? WHERE id = ? AND token_version = ? AND banned = 0')
      .bind(name, name.toLowerCase(), Date.now(), row.id, row.token_version)
      .run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'username_taken');
    throw e;
  }
  if (!res.meta || !res.meta.changes) throw new HttpError(401, 'invalid_token');

  await logEvent(env, req, row.id, 'rename', `${row.username} -> ${name}`);
  await notifyRoom(env, b.room, '/rename', { uid: row.id, name });
  return json(await issueToken(env, { ...row, username: name }));
}

async function logoutAll(req, env) {
  const claims = await authed(req, env);
  if (!claims) throw new HttpError(401, 'invalid_token');
  const res = await env.DB
    .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ? AND token_version = ?')
    .bind(claims.u, claims.v).run();
  if (!res.meta || !res.meta.changes) throw new HttpError(401, 'invalid_token');
  await logEvent(env, req, claims.u, 'logout_all', null);
  return json({ ok: true });
}

async function adminBan(req, env) {
  const h = req.headers.get('Authorization') || '';
  if (!env.ADMIN_KEY || !h.startsWith('Bearer ') || !(await safeEqStr(h.slice(7).trim(), env.ADMIN_KEY))) {
    throw new HttpError(401, 'unauthorized');
  }
  const b = await readJson(req);
  const lc = String(b.username ?? '').toLowerCase();
  const banned = b.banned === false ? 0 : 1;
  const reason = banned ? String(b.reason ?? '').slice(0, 200) : null;

  const row = await env.DB.prepare('SELECT id FROM users WHERE username_lc = ?').bind(lc).first();
  if (!row) throw new HttpError(404, 'no_such_user');
  await env.DB
    .prepare('UPDATE users SET banned = ?, ban_reason = ?, token_version = token_version + 1 WHERE id = ?')
    .bind(banned, reason, row.id).run();
  await logEvent(env, req, row.id, banned ? 'ban' : 'unban', reason);

  // Optional: kick them out of named rooms right now instead of waiting for the next sweep.
  const rooms = Array.isArray(b.rooms) ? b.rooms.slice(0, 10) : [];
  for (const r of rooms) await notifyRoom(env, r, '/revalidate', {});
  return json({ ok: true });
}

function originAllowed(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // non-browser clients: the token is the real gate
  const allowed = String(env.ALLOWED_ORIGINS || 'https://gats.io').split(',').map((s) => s.trim());
  if (allowed.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'gats.io' || u.hostname.endsWith('.gats.io'));
  } catch {
    return false;
  }
}

async function presence(req, env, url) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
  if (!originAllowed(req, env)) return new Response('forbidden origin', { status: 403 });

  const room = (url.searchParams.get('room') || '').toLowerCase();
  if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });

  // Browsers can't set headers on WebSockets, so the token rides in Sec-WebSocket-Protocol
  // (not in the URL, which would end up in logs).
  const protos = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  if (protos[0] !== 'gcl.v1' || !protos[1]) return new Response('bad protocol', { status: 400 });
  const claims = await verifyToken(env.TOKEN_SECRET, protos[1]);
  if (!claims) return new Response('invalid token', { status: 401 });

  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('x-gcl-')) headers.delete(k);
  headers.set('x-gcl-uid', claims.u);
  headers.set('x-gcl-ver', String(claims.v));
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  return stub.fetch(new Request(req, { headers }));
}

// ---- router ----------------------------------------------------------------------------

const POST_ROUTES = {
  '/register': register,
  '/login': login,
  '/refresh': refresh,
  '/rename': rename,
  '/logout-all': logoutAll,
  '/admin/ban': adminBan,
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/presence') return await presence(req, env, url);
      const h = POST_ROUTES[url.pathname];
      if (!h) return json({ error: 'not_found' }, 404);
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return await h(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      console.error(e);
      return json({ error: 'internal' }, 500);
    }
  },
};
