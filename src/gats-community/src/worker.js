// login-info-handler: stateless front door.
// Routes: POST /register /login /refresh /rename /admin/ban, GET /presence (WebSocket), GET /health
// Secrets: TOKEN_SECRET, PEPPER, ADMIN_KEY.  Bindings: DB (D1), ROOMS + GATE (Durable Objects).

import { Room } from './room.js';
import { Gate, ipKey } from './gate.js';
import { Verifier } from './verifier.js';
export { Room, Gate, Verifier };

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
const dec = new TextDecoder();
const MAX_BODY = 2048;
// base64url without per-byte string concatenation or chained regex copies.
const B64_FIX = { '+': '-', '/': '_', '=': '' };
const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return btoa(String.fromCharCode.apply(null, b)).replace(/[+/=]/g, (c) => B64_FIX[c]); // inputs here are <= 256 bytes
  },
  dec(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/')); // atob accepts unpadded input
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

// The Worker uses exactly two HMAC secrets (TOKEN_SECRET, PEPPER). Two fixed slots: no growth, no re-imports
// (a single slot thrashed between them on /login and /register; a Map would keep a second copy of each secret).
// Idea and measurement: claude-1 / researcher-1 (#15). A third secret would evict round-robin.
const slots = [{ s: null, p: null }, { s: null, p: null }];
let nextSlot = 0;
function hmacKey(secret) {
  if (!secret) throw new Error('missing secret');
  for (const x of slots) if (x.s === secret) return x.p;
  const x = slots[nextSlot];
  nextSlot ^= 1;
  x.s = secret;
  x.p = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return x.p;
}

async function signToken(env, claims) {
  const payload = b64u.enc(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode('v1.' + payload));
  return `v1.${payload}.${b64u.enc(sig)}`;
}

async function verifyToken(env, token, typ) {
  try {
    const [v, payload, sig] = String(token).split('.');
    if (v !== 'v1' || !payload || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TOKEN_SECRET), b64u.dec(sig), enc.encode(`v1.${payload}`));
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(b64u.dec(payload)));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    if ((claims.typ || '') !== (typ || '')) return null; // login tickets (typ vt) can never be used as session tokens
    return claims;
  } catch {
    return null;
  }
}

const pwData = (uid, key) => enc.encode(`pw1|${uid}|${key}`);
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
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; // init object reused, never mutated
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

// Reads at most MAX_BODY bytes into one fixed buffer; oversize or chunked-flood bodies are cancelled, not buffered.
async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY || !req.body) return null;
  const reader = req.body.getReader();
  const buf = new Uint8Array(MAX_BODY);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > MAX_BODY) { reader.cancel().catch(() => {}); return null; }
      buf.set(value, n);
      n += value.length;
    }
    return JSON.parse(dec.decode(buf.subarray(0, n)));
  } catch {
    return null;
  }
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
// The per-IP gate runs first and alone, and the global cap is only counted for requests that passed it and carry a
// valid body: otherwise one IP could burn the shared daily cap with rejected or garbage requests (#47).
const throttleRegisterIp = async (env, req) => !(await gate(env, 'reg:' + clientIp(req), '/hit', 5, 3600)).locked;
async function throttleRegisterDay(env) {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Math.max(1, Number(env.MAX_REG_PER_DAY) || 300);
  return !(await gate(env, 'regday:' + day, '/hit', cap, 86400)).locked;
}
const throttleRename = async (env, req) => !(await gate(env, 'ren:' + clientIp(req), '/hit', 10, 3600)).locked;

const isUnique = (e) => /UNIQUE/i.test(String(e && e.message) + String(e && e.cause));
// Canonical form: lowercase, drop . _ - separators and trailing digits, fold look-alikes (0->o, 1/l->i, 3->e, 4->a, 5->s, 7->t).
const FOLD = { 0: 'o', 1: 'i', l: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };
const foldName = (s) => s.replace(/[013457l]/g, (c) => FOLD[c]);
// Two canonical forms, because a trailing digit is either a counter (admin2 -> admin) or a look-alike letter (roo7 -> root):
// strip trailing digits then fold, and fold then strip trailing digits. A name is reserved if either form is reserved.
const canonForms = (u) => {
  const s = String(u).toLowerCase().replace(/[._-]/g, '');
  return [foldName(s.replace(/\d+$/, '')), foldName(s).replace(/\d+$/, '')];
};
const RESERVED_CANON = new Set([...RESERVED_NAMES].flatMap(canonForms));
const isReservedUsername = (username) => RESERVED_NAMES.has(String(username).toLowerCase()) || canonForms(username).some((c) => RESERVED_CANON.has(c));
// Compiled once per distinct config value, not per request.
let roomRules = null;
function isAllowedRoom(room, env) {
  const value = String(room || '').toLowerCase();
  const re = env.ROOM_REGEX || '^[a-z0-9.:-]{1,64}$';
  const suffix = String(env.ALLOWED_ROOM_SUFFIX || 'gats.io').toLowerCase();
  if (!roomRules || roomRules.re !== re || roomRules.suffix !== suffix) roomRules = { re, suffix, rx: new RegExp(re) };
  if (!roomRules.rx.test(value)) return false;
  const host = value.split(':')[0];
  return !!suffix && (host === suffix || host.endsWith('.' + suffix));
}
let originRules = null;
function originAllowed(origin, env) {
  const raw = env.ALLOWED_ORIGINS || 'https://gats.io,https://www.gats.io';
  if (!originRules || originRules.raw !== raw) originRules = { raw, set: new Set(raw.split(',').map((x) => x.trim())) };
  return originRules.set.has(origin);
}

async function session(env, user) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_S;
  const token = await signToken(env, { uid: user.id, name: user.username, tv: user.token_version, iat, exp });
  return { token, exp: exp * 1000, user: { id: user.id, username: user.username } };
}

const logEvent = (env, uid, type, data, ip, at = Date.now()) =>
  env.DB.prepare('INSERT INTO events (user_id,type,data,ip_hash,at) VALUES (?1,?2,?3,?4,?5)').bind(uid, type, data ? JSON.stringify(data) : null, ip, at);


// ---------- email verification (EMAIL_VERIFY=on; docs/design-email-verification.md) ----------
const EMAIL_RE = /^[^\s@,;<>()"'\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const DEV_RE = /^[A-Za-z0-9_-]{22,43}$/;
const TICKET_TTL_S = 600;
const VB_LIMIT = 10, VB_WIN_S = 3600; // wrong codes per IP/64 per hour before that IP is banned until the window ends
const USER_COLS = 'id,username,pw_hash,banned,ban_reason,token_version';
const USER_COLS_EMAIL = USER_COLS + ',email,email_verified_at';
const emailOn = (env) => env.EMAIL_VERIFY === 'on';
const normEmail = (e) => { const x = String(e || '').trim().toLowerCase(); return x.length <= 254 && EMAIL_RE.test(x) ? x : null; };
const maskEmail = (e) => { const i = e.indexOf('@'); return e[0] + '***' + e.slice(i); };
const ipBanned = async (env, req) => (await gate(env, 'vb:' + clientIp(req), '/check', VB_LIMIT, VB_WIN_S)).locked;

async function devHash(env, uid, dev) {
  return b64u.enc(await crypto.subtle.sign('HMAC', await hmacKey(env.PEPPER), enc.encode('dev1|' + uid + '|' + dev))).slice(0, 22);
}
async function codeHash(env, uid, code) {
  return b64u.enc(await crypto.subtle.sign('HMAC', await hmacKey(env.PEPPER), enc.encode('code1|' + uid + '|' + code)));
}
// Uniform 6 digits: reject the top sliver of the uint32 range so the modulo has no bias (4294000000 = 4294 * 1e6).
function newCode() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4294000000);
  return String(a[0] % 1000000).padStart(6, '0');
}
const verifierCall = async (env, uid, path) => {
  const res = await env.VERIFIER.get(env.VERIFIER.idFromName(uid)).fetch('https://verifier' + path);
  return { status: res.status, body: await res.json() };
};
const makeTicket = (env, uid, purpose, dh) =>
  signToken(env, { typ: 'vt', uid, p: purpose, dh: dh || null, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_S });

// The Worker only ever calls the provider; swap by setting MAIL_PROVIDER. Never logs the address or the code.
async function sendMail(env, to, code) {
  if (typeof env.MAILER === 'function') return env.MAILER(to, code); // tests
  if (env.MAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('mail_not_configured');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM, to: [to],
      subject: 'Your gats.io login code: ' + code,
      text: 'Your gats.io verification code is ' + code + '. It expires in 10 minutes.\nIf you did not ask for it, ignore this email; nobody can use it without your password.',
    }),
  });
  if (!r.ok) throw new Error('mail_http_' + r.status);
}

// Generates and emails a code. Returns null on success or a Response to hand back to the client.
// Email is a scarce budget (Resend free = 100/day), so: per-account cooldown + hourly cap (Verifier), per-IP cap, global daily cap.
async function sendCode(env, req, uid, email) {
  const ipLim = await gate(env, 'ms:' + clientIp(req), '/hit', 10, 3600);
  if (ipLim.locked) return json({ error: 'rate_limited' }, 429);
  const code = newCode();
  const put = await verifierCall(env, uid, '/put?h=' + encodeURIComponent(await codeHash(env, uid, code)));
  if (put.status === 429) return json({ error: put.body.error === 'cooldown' ? 'resend_cooldown' : 'rate_limited', retryAfter: put.body.retryAfter }, 429);
  const day = new Date().toISOString().slice(0, 10);
  const cap = Math.max(1, Number(env.MAIL_DAILY_CAP) || 80);
  if ((await gate(env, 'maild:' + day, '/hit', cap, 86400)).locked) {
    await verifierCall(env, uid, '/clear');
    return json({ error: 'email_busy' }, 503);
  }
  try {
    await sendMail(env, email, code);
  } catch (e) {
    console.error('mail error', e && e.message);
    await verifierCall(env, uid, '/clear');
    return json({ error: 'email_failed' }, 502);
  }
  return null;
}
const challenge = async (env, uid, purpose, dh, email) =>
  json({ verify: 'code', purpose, hint: maskEmail(email), ticket: await makeTicket(env, uid, purpose, dh), codeTtl: 600 }, 202);
const parseDev = async (env, uid, b) => (DEV_RE.test(String((b && b.dev) || '')) ? devHash(env, uid, b.dev) : null);

// ---------- handlers ----------
async function register(req, env) {
  const on = emailOn(env);
  if (on && (await ipBanned(env, req))) return json({ error: 'ip_banned' }, 429);
  if (!(await throttleRegisterIp(env, req))) return json({ error: 'rate_limited' }, 429);
  const b = await readBody(req);
  if (!b || !USERNAME_RE.test(String(b.username || '')) || !KEY_RE.test(String(b.key || ''))) return json({ error: 'invalid_input' }, 400);
  const email = on ? normEmail(b.email) : null;
  if (on && !email) return json({ error: 'invalid_email' }, 400);
  if (isReservedUsername(b.username)) return json({ error: 'name_taken' }, 409);
  if (!(await throttleRegisterDay(env))) return json({ error: 'rate_limited' }, 429);
  const uid = b64u.enc(crypto.getRandomValues(new Uint8Array(12)));
  const lc = b.username.toLowerCase();
  const hash = await pwHash(env, uid, b.key);
  const now = Date.now();
  const insert = on
    ? env.DB.prepare('INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,created_at,email,email_lc) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)').bind(uid, lc, b.username, lc, hash, KDF, now, b.email.trim(), email)
    : env.DB.prepare('INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)').bind(uid, lc, b.username, lc, hash, KDF, now);
  try {
    // Never-verified signups older than 1 h release their name and address (lazy cleanup, no cron).
    if (on) await env.DB.prepare('DELETE FROM users WHERE (login=?1 OR email_lc=?2) AND email IS NOT NULL AND email_verified_at IS NULL AND created_at<?3').bind(lc, email, now - 3600000).run();
    await env.DB.batch([insert, logEvent(env, uid, 'register', null, await ipHash(env, req), now)]);
  } catch (e) {
    if (isUnique(e)) {
      if (on && (await env.DB.prepare('SELECT 1 AS x FROM users WHERE email_lc=?1').bind(email).first())) return json({ error: 'email_taken' }, 409);
      return json({ error: 'name_taken' }, 409);
    }
    throw e;
  }
  if (!on) return json(await session(env, { id: uid, username: b.username, token_version: 1 }));
  const err = await sendCode(env, req, uid, email);
  if (err) return err; // the unverified row stays; logging in with the password re-sends a code
  return challenge(env, uid, 'verify', await parseDev(env, uid, b), email);
}

async function login(req, env) {
  const b = await readBody(req);
  const lc = String((b && b.login) || '').toLowerCase();
  if (!b || !USERNAME_RE.test(lc) || !KEY_RE.test(String(b.key || ''))) return json({ error: 'invalid_input' }, 400);
  // Failures only are counted: 20 per IP/64 and 10 per account per 15 min. No D1 writes, state survives eviction.
  // The per-account Gate is only touched for accounts that exist, so random names cannot spawn Gate DOs.
  const ipk = 'li:' + clientIp(req), lk = 'll:' + lc;
  // /try reserves a slot atomically in the Gate, so a parallel burst cannot all pass a read-only check
  // before the first failure is counted (#31). Every path below must end in /fail, /ok or /done.
  const on = emailOn(env);
  if (on && (await ipBanned(env, req))) return json({ error: 'ip_banned' }, 429);
  const gi = await gate(env, ipk, '/try', 20, 900);
  if (gi.locked) return json({ error: 'rate_limited' }, 429);
  const row = await env.DB.prepare('SELECT ' + (on ? USER_COLS_EMAIL : USER_COLS) + ' FROM users WHERE login=?1').bind(lc).first();
  const gl = row ? await gate(env, lk, '/try', 10, 900) : { locked: false, n: 0 };
  if (gl.locked) { await gate(env, ipk, '/done', 20, 900); return json({ error: 'rate_limited' }, 429); }
  // Always do one HMAC verify so unknown users cost the same as wrong passwords.
  const ok = row ? await pwVerify(env, row.id, b.key, row.pw_hash) : (await pwVerify(env, '0', b.key, DUMMY_HASH), false);
  if (!ok) {
    await Promise.all([gate(env, ipk, '/fail', 20, 900), row ? gate(env, lk, '/fail', 10, 900) : null]);
    return json({ error: 'invalid_credentials' }, 401);
  }
  await Promise.all([gate(env, ipk, '/done', 20, 900), gate(env, lk, '/ok', 10, 900)]); // release slots; success clears the account counter
  if (row.banned) return json({ error: 'banned', reason: row.ban_reason || null }, 403);
  if (on) {
    // Password is right. A session needs: a verified email AND a device we have seen verified before.
    const dh = await parseDev(env, row.id, b);
    if (!row.email) return json({ verify: 'email', purpose: 'email_needed', ticket: await makeTicket(env, row.id, 'email_needed', dh) }, 202);
    const known = row.email_verified_at && dh && (await env.DB.prepare('SELECT 1 AS x FROM devices WHERE user_id=?1 AND dev_hash=?2').bind(row.id, dh).first());
    if (!known) {
      const err = await sendCode(env, req, row.id, row.email.toLowerCase());
      if (err) return err;
      return challenge(env, row.id, row.email_verified_at ? 'device' : 'verify', dh, row.email);
    }
  }
  // Soft cap: beyond 20 logins/hour per account the login still succeeds but is not logged (protects D1 write quota).
  if (!(await gate(env, 'ls:' + lc, '/hit', 20, 3600)).locked) await logEvent(env, row.id, 'login', null, await ipHash(env, req)).run();
  return json(await session(env, row));
}

// POST /verify {ticket, code}: finishes register / new-device login. Wrong codes count against the code (5 tries) and the
// IP /64 (10/hour => IP banned for the rest of that hour). They never lock the account.
async function verify(req, env) {
  if (await ipBanned(env, req)) return json({ error: 'ip_banned' }, 429);
  const b = await readBody(req);
  const t = b && (await verifyToken(env, b.ticket, 'vt'));
  if (!t || (t.p !== 'verify' && t.p !== 'device')) return json({ error: 'ticket_expired' }, 401);
  const code = String(b.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ error: 'invalid_code_format' }, 400);
  const ipk = 'vb:' + clientIp(req);
  const gi = await gate(env, ipk, '/try', VB_LIMIT, VB_WIN_S); // reserve a slot so parallel guesses cannot all pass before counting
  if (gi.locked) return json({ error: 'ip_banned' }, 429);
  const r = (await verifierCall(env, t.uid, '/check?h=' + encodeURIComponent(await codeHash(env, t.uid, code)))).body;
  if (r.status === 'wrong' || r.status === 'dead') {
    const g = await gate(env, ipk, '/fail', VB_LIMIT, VB_WIN_S);
    if (g.locked) return json({ error: 'ip_banned' }, 429);
    return json({ error: r.status === 'dead' ? 'code_expired' : 'code_invalid', left: r.left || 0 }, r.status === 'dead' ? 410 : 401);
  }
  await gate(env, ipk, '/done', VB_LIMIT, VB_WIN_S); // release without counting; a success never clears earlier failures
  if (r.status !== 'ok') return json({ error: 'code_expired' }, 410);
  const row = await env.DB.prepare('SELECT id,username,banned,token_version,email_verified_at FROM users WHERE id=?1').bind(t.uid).first();
  if (!row || row.banned) return json({ error: 'revoked' }, 401);
  const now = Date.now();
  const batch = [logEvent(env, row.id, 'verify', { p: t.p }, await ipHash(env, req), now)];
  if (!row.email_verified_at) batch.push(env.DB.prepare('UPDATE users SET email_verified_at=?1 WHERE id=?2').bind(now, row.id));
  if (t.dh) {
    batch.push(env.DB.prepare('INSERT INTO devices (user_id,dev_hash,first_seen,last_seen) VALUES (?1,?2,?3,?3) ON CONFLICT(user_id,dev_hash) DO UPDATE SET last_seen=?3').bind(row.id, t.dh, now));
    batch.push(env.DB.prepare('DELETE FROM devices WHERE user_id=?1 AND dev_hash NOT IN (SELECT dev_hash FROM devices WHERE user_id=?1 ORDER BY last_seen DESC LIMIT 10)').bind(row.id));
  }
  await env.DB.batch(batch);
  return json(await session(env, row));
}

// POST /resend {ticket}: new code for an open verify/device ticket.
async function resend(req, env) {
  if (await ipBanned(env, req)) return json({ error: 'ip_banned' }, 429);
  const b = await readBody(req);
  const t = b && (await verifyToken(env, b.ticket, 'vt'));
  if (!t || (t.p !== 'verify' && t.p !== 'device')) return json({ error: 'ticket_expired' }, 401);
  const row = await env.DB.prepare('SELECT email,banned FROM users WHERE id=?1').bind(t.uid).first();
  if (!row || row.banned || !row.email) return json({ error: 'revoked' }, 401);
  const err = await sendCode(env, req, t.uid, row.email.toLowerCase());
  if (err) return err;
  return challenge(env, t.uid, t.p, t.dh, row.email);
}

// POST /email {ticket, email}: accounts created before email verification attach their first address.
async function addEmail(req, env) {
  if (await ipBanned(env, req)) return json({ error: 'ip_banned' }, 429);
  const b = await readBody(req);
  const t = b && (await verifyToken(env, b.ticket, 'vt'));
  if (!t || t.p !== 'email_needed') return json({ error: 'ticket_expired' }, 401);
  const email = normEmail(b.email);
  if (!email) return json({ error: 'invalid_email' }, 400);
  let r;
  try {
    r = await env.DB.prepare('UPDATE users SET email=?1, email_lc=?2 WHERE id=?3 AND email IS NULL AND banned=0').bind(String(b.email).trim(), email, t.uid).run();
  } catch (e) {
    if (isUnique(e)) return json({ error: 'email_taken' }, 409);
    throw e;
  }
  if (!r.meta.changes) return json({ error: 'revoked' }, 401);
  const err = await sendCode(env, req, t.uid, email);
  if (err) return err;
  return challenge(env, t.uid, 'verify', t.dh, email);
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
  if (origin && !originAllowed(origin, env)) return json({ error: 'forbidden_origin' }, 403);

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
  // Failed admin-key guesses are throttled per IP/64 (10 per 15 min); /try reserves a slot so a parallel burst cannot all pass.
  const adk = 'adm:' + clientIp(req);
  if (!env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
  if ((await gate(env, adk, '/try', 10, 900)).locked) return json({ error: 'rate_limited' }, 429);
  if (!(await safeEqual(env, req.headers.get('X-Admin-Key') || '', env.ADMIN_KEY))) {
    await gate(env, adk, '/fail', 10, 900);
    return json({ error: 'unauthorized' }, 401);
  }
  await gate(env, adk, '/ok', 10, 900);
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
      if (emailOn(env) && pathname === '/verify') return await verify(req, env);
      if (emailOn(env) && pathname === '/resend') return await resend(req, env);
      if (emailOn(env) && pathname === '/email') return await addEmail(req, env);
      if (pathname === '/rename') return await rename(req, env, ctx);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('worker error', e && e.stack ? e.stack : e);
      return json({ error: 'server_error' }, 500);
    }
  },
};
