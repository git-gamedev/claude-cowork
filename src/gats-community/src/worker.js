// login-info-handler: stateless front door.
// Routes: POST /register /login /refresh /rename /admin/ban, GET /presence (WebSocket), GET /health
// Secrets: TOKEN_SECRET, PEPPER, ADMIN_KEY.  Bindings: DB (D1), ROOMS + GATE (Durable Objects).

import { Room } from './room.js';
import { Gate, ipKey } from './gate.js';
export { Room, Gate };

const enc = new TextEncoder();
const TOKEN_TTL_S = 7 * 24 * 3600;
const KDF = 'c-pbkdf2-600k+hmac-v1';
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/; // no commas/pipes: names are spliced into game frames
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;          // 32 bytes base64url, derived client-side
const DUMMY_HASH = 'A'.repeat(43);
const RESERVED_NAMES = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'staff', 'owner',
  'system', 'server', 'gats', 'gats.io', 'official', 'support', 'root',
]);
const RENAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---------- encoding / crypto helpers ----------
const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  },
};

const keyCache = new Map();
function hmacKey(secret) {
  if (!secret) throw new Error('missing secret');
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keyCache.get(secret);
}

async function signToken(env, claims) {
  const payload = b64u.enc(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode('v1.' + payload));
  return `v1.${payload}.${b64u.enc(sig)}`;
}

async function verifyToken(env, token) {
  try {
    const [v, payload, sig] = String(token).split('.');
    if (v !== 'v1' || !payload || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TOKEN_SECRET), b64u.dec(sig), enc.encode(`v1.${payload}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64u.dec(payload)));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

async function pwData(uid, key) { return enc.encode(`pw1|${uid}|${key}`); }
async function pwHash(env, uid, key) {
  return b64u.enc(await crypto.subtle.sign('HMAC', await hmacKey(env.PEPPER), await pwData(uid, key)));
}
// crypto.subtle.verify is constant-time
async function pwVerify(env, uid, key, stored) {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(env.PEPPER), b64u.dec(stored), await pwData(uid, key));
  } catch {
    return false;
  }
}

async function ipHash(env, req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const d = await crypto.subtle.digest('SHA-256', enc.encode(ip + '|' + env.TOKEN_SECRET));
  return b64u.enc(d).slice(0, 16);
}

async function safeEqual(env, a, b) {
  const k = await hmacKey(env.TOKEN_SECRET);
  const [x, y] = await Promise.all([crypto.subtle.sign('HMAC', k, enc.encode(a)), crypto.subtle.sign('HMAC', k, enc.encode(b))]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < xa.length; i++) d |= xa[i] ^ ya[i];
  return d === 0;
}

// ---------- http helpers ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > 2048) return null;
  try { return await req.json(); } catch { return null; }
}

async function authClaims(req, env) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? verifyToken(env, h.slice(7)) : null;
}

// Rate limiting via Gate DOs. Fails OPEN if a Gate is unreachable, so an outage there cannot lock everyone out.
async function gate(env, key, path, limit, winSec) {
  try {
    const res = await env.GATE.get(env.GATE.idFromName(key)).fetch(`https://gate${path}?limit=${limit}&win=${winSec}`);
    const body = await res.json();
    return { locked: res.status === 429 || !!body.locked, n: body.n || 0 };
  } catch (e) {
    console.error('gate error', key, e && e.message);
    return { locked: false, n: 0 };
  }
}
const clientIp = (req) => ipKey(req.headers.get('CF-Connecting-IP'));

// register: 5 per IP/64 per hour, plus a global daily cap (D1 free plan is ~100k row writes/day).
async function throttleRegister(env, req) {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Math.max(1, Number(env.MAX_REG_PER_DAY) || 300);
  const [ip, all] = await Promise.all([
    gate(env, 'reg:' + clientIp(req), '/hit', 5, 3600),
    gate(env, 'regday:' + day, '/hit', cap, 86400),
  ]);
  return !(ip.locked || all.locked);
}
const throttleRename = async (env, req) => !(await gate(env, 'ren:' + clientIp(req), '/hit', 10, 3600)).locked;

const isUnique = (e) => /UNIQUE/i.test(String(e && e.message) + String(e && e.cause));
const isReservedUsername = (username) => RESERVED_NAMES.has(String(username).toLowerCase());
function isAllowedRoom(room, env) {
  const value = String(room || '').toLowerCase();
  if (!new RegExp(env.ROOM_REGEX || '^[a-z0-9.:-]{1,64}$').test(value)) return false;
  const host = value.split(':')[0];
  const suffix = String(env.ALLOWED_ROOM_SUFFIX || 'gats.io').toLowerCase();
  return !!suffix && (host === suffix || host.endsWith('.' + suffix));
}

async function session(env, user) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_S;
  const token = await signToken(env, { uid: user.id, name: user.username, tv: user.token_version, iat, exp });
  return { token, exp: exp * 1000, user: { id: user.id, username: user.username } };
}

const logEvent = (env, uid, type, data, ip, at = Date.now()) =>
  env.DB.prepare('INSERT INTO events (user_id,type,data,ip_hash,at) VALUES (?1,?2,?3,?4,?5)').bind(uid, type, data ? JSON.stringify(data) : null, ip, at);

// ---------- handlers ----------
async function register(req, env) {
  if (!(await throttleRegister(env, req))) return json({ error: 'rate_limited' }, 429);
  const b = await readBody(req);
  if (!b || !USERNAME_RE.test(String(b.username || '')) || !KEY_RE.test(String(b.key || ''))) return json({ error: 'invalid_input' }, 400);
  if (isReservedUsername(b.username)) return json({ error: 'name_taken' }, 409);
  const uid = b64u.enc(crypto.getRandomValues(new Uint8Array(12)));
  const lc = b.username.toLowerCase();
  const hash = await pwHash(env, uid, b.key);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
        .bind(uid, lc, b.username, lc, hash, KDF, now),
      logEvent(env, uid, 'register', null, await ipHash(env, req), now),
    ]);
  } catch (e) {
    if (isUnique(e)) return json({ error: 'name_taken' }, 409);
    throw e;
  }
  return json(await session(env, { id: uid, username: b.username, token_version: 1 }));
}

async function login(req, env) {
  const b = await readBody(req);
  const lc = String((b && b.login) || '').toLowerCase();
  if (!b || !USERNAME_RE.test(lc) || !KEY_RE.test(String(b.key || ''))) return json({ error: 'invalid_input' }, 400);
  // Failures only are counted: 20 per IP/64 and 10 per account per 15 min. No D1 writes, state survives eviction.
  // The per-account Gate is only touched for accounts that exist, so random names cannot spawn Gate DOs.
  const ipk = 'li:' + clientIp(req), lk = 'll:' + lc;
  const gi = await gate(env, ipk, '/check', 20, 900);
  if (gi.locked) return json({ error: 'rate_limited' }, 429);
  const row = await env.DB.prepare('SELECT id,username,pw_hash,banned,ban_reason,token_version FROM users WHERE login=?1').bind(lc).first();
  const gl = row ? await gate(env, lk, '/check', 10, 900) : { locked: false, n: 0 };
  if (gl.locked) return json({ error: 'rate_limited' }, 429);
  // Always do one HMAC verify so unknown users cost the same as wrong passwords.
  const ok = row ? await pwVerify(env, row.id, b.key, row.pw_hash) : (await pwVerify(env, '0', b.key, DUMMY_HASH), false);
  if (!ok) {
    await Promise.all([gate(env, ipk, '/fail', 20, 900), row ? gate(env, lk, '/fail', 10, 900) : null]);
    return json({ error: 'invalid_credentials' }, 401);
  }
  if (gl.n > 0) await gate(env, lk, '/ok', 10, 900);
  if (row.banned) return json({ error: 'banned', reason: row.ban_reason || null }, 403);
  // Soft cap: beyond 20 logins/hour per account the login still succeeds but is not logged (protects D1 write quota).
  if (!(await gate(env, 'ls:' + lc, '/hit', 20, 3600)).locked) await logEvent(env, row.id, 'login', null, await ipHash(env, req)).run();
  return json(await session(env, row));
}

async function refresh(req, env) {
  const c = await authClaims(req, env);
  if (!c) return json({ error: 'unauthorized' }, 401);
  const row = await env.DB.prepare('SELECT id,username,banned,token_version FROM users WHERE id=?1').bind(c.uid).first();
  if (!row || row.banned || row.token_version !== c.tv) return json({ error: 'revoked' }, 401);
  return json(await session(env, row));
}

async function rename(req, env, ctx) {
  const c = await authClaims(req, env);
  if (!c) return json({ error: 'unauthorized' }, 401);
  if (!(await throttleRename(env, req))) return json({ error: 'rate_limited' }, 429);
  const b = await readBody(req);
  if (!b || !USERNAME_RE.test(String(b.username || ''))) return json({ error: 'invalid_input' }, 400);
  if (isReservedUsername(b.username)) return json({ error: 'name_taken' }, 409);
  const lc = b.username.toLowerCase();
  const now = Date.now();
  let r;
  try {
    // Revocation and rename cooldown are checked inside the same UPDATE.
    r = await env.DB.prepare('UPDATE users SET username=?1, username_lc=?2, renamed_at=?3 WHERE id=?4 AND banned=0 AND token_version=?5 AND COALESCE(renamed_at,0)<=?6')
      .bind(b.username, lc, now, c.uid, c.tv, now - RENAME_COOLDOWN_MS).run();
  } catch (e) {
    if (isUnique(e)) return json({ error: 'name_taken' }, 409);
    throw e;
  }
  if (!r.meta.changes) {
    const row = await env.DB.prepare('SELECT banned, token_version, COALESCE(renamed_at,0) AS renamed_at FROM users WHERE id=?1').bind(c.uid).first();
    if (!row || row.banned || row.token_version !== c.tv) return json({ error: 'revoked' }, 401);
    const retryAt = Number(row.renamed_at || 0) + RENAME_COOLDOWN_MS;
    if (retryAt > now) return json({ error: 'rename_cooldown', retryAfter: Math.ceil((retryAt - now) / 1000) }, 429);
    return json({ error: 'revoked' }, 401);
  }
  await logEvent(env, c.uid, 'rename', { from: c.name, to: b.username }, await ipHash(env, req)).run();

  const room = typeof b.room === 'string' ? b.room.toLowerCase() : '';
  if (isAllowedRoom(room, env)) {
    ctx.waitUntil(
      env.ROOMS.get(env.ROOMS.idFromName(room))
        .fetch('https://room/rename', { method: 'POST', body: JSON.stringify({ uid: c.uid, name: b.username }) })
        .catch(() => {})
    );
  }
  return json(await session(env, { id: c.uid, username: b.username, token_version: c.tv }));
}

async function presence(req, env) {
  if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || 'https://gats.io,https://www.gats.io').split(',').map((s) => s.trim());
  if (origin && !allowed.includes(origin)) return json({ error: 'forbidden_origin' }, 403);

  // Token travels in Sec-WebSocket-Protocol so it never appears in a URL or access log.
  const protos = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  if (protos[0] !== 'gcl.v1' || !protos[1]) return json({ error: 'unauthorized' }, 401);
  const claims = await verifyToken(env, protos[1]);
  if (!claims) return json({ error: 'unauthorized' }, 401);

  const room = (new URL(req.url).searchParams.get('room') || '').toLowerCase();
  if (!isAllowedRoom(room, env)) return json({ error: 'bad_room' }, 400);

  const h = new Headers(req.headers);
  h.set('x-uid', claims.uid); h.set('x-name', claims.name); h.set('x-tv', String(claims.tv)); // overwrite any client-sent values
  return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request('https://room/ws', { headers: h }));
}

async function adminBan(req, env) {
  if (!env.ADMIN_KEY || !(await safeEqual(env, req.headers.get('X-Admin-Key') || '', env.ADMIN_KEY))) return json({ error: 'unauthorized' }, 401);
  const b = await readBody(req);
  const login = String((b && b.login) || '').toLowerCase();
  if (!b || !USERNAME_RE.test(login)) return json({ error: 'invalid_input' }, 400);
  const banned = b.banned === false ? 0 : 1;
  const row = await env.DB.prepare('UPDATE users SET banned=?1, ban_reason=?2, token_version=token_version+1 WHERE login=?3 RETURNING id')
    .bind(banned, banned ? String(b.reason || '').slice(0, 200) : null, login).first();
  if (!row) return json({ error: 'not_found' }, 404);
  await logEvent(env, row.id, banned ? 'ban' : 'unban', { reason: b.reason || null }, null).run();
  // Optional instant kick: pass the room names the user is likely in. Others pick it up within ~5 min.
  for (const r of (Array.isArray(b.rooms) ? b.rooms : []).slice(0, 20)) {
    const room = String(r).toLowerCase();
    if (banned && isAllowedRoom(room, env)) {
      await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch('https://room/kick', { method: 'POST', body: JSON.stringify({ uid: row.id }) }).catch(() => {});
    }
  }
  return json({ ok: true, banned: !!banned });
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/health') return json({ ok: true });
      if (pathname === '/presence' && req.method === 'GET') return await presence(req, env);
      if (pathname === '/admin/ban' && req.method === 'POST') return await adminBan(req, env);
      if (req.method !== 'POST') return json({ error: 'not_found' }, 404);

      if (pathname === '/register') return await register(req, env);
      if (pathname === '/login') return await login(req, env);
      if (pathname === '/refresh') return await refresh(req, env);
      if (pathname === '/rename') return await rename(req, env, ctx);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('worker error', e && e.stack ? e.stack : e);
      return json({ error: 'server_error' }, 500);
    }
  },
};
