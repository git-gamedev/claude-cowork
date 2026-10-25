// lib.js — shared helpers used by index.js (Worker) and room.js (Durable Object).
// No state lives here.

const enc = new TextEncoder();

export const nowSec = () => Math.floor(Date.now() / 1000);

// ---- validation ------------------------------------------------------------
// Usernames end up inside comma/pipe-delimited game frames, so keep them boring.
export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const SALT_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url
export const PH_RE = /^[A-Za-z0-9_-]{43}$/;     // 32 bytes (client PBKDF2 output), base64url
export const ROOM_RE = /^[a-z0-9._:-]{1,64}$/;  // room = game server host[:port]
export const GID_RE = /^[A-Za-z0-9]{1,12}$/;    // in-game player id

export const DEFAULT_KDF_ITER = 250000;         // what the userscript uses
export const MIN_KDF_ITER = 100000;
export const MAX_KDF_ITER = 2000000;

// ---- base64url -------------------------------------------------------------
export function b64uEncode(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- constant-time string compare (equal-length inputs only) ----------------
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ---- hashing / keys --------------------------------------------------------
// Password storage: the client already ran PBKDF2 (the expensive part). The
// server only stores SHA-256 of that output, so a D1 leak does not hand out
// login-capable values and the Worker stays far below the 10 ms CPU cap.
export async function pwHash(ph) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode('gcl-pw-v1|' + ph));
  return b64uEncode(d);
}

const keyCache = new Map();

// One wrangler secret (AUTH_SECRET); sub-keys are derived per purpose so the
// token key and the fake-salt key are never the same key.
async function subKey(env, label) {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET missing or too short');
  const ck = label + '|' + secret.length;
  if (keyCache.has(ck)) return keyCache.get(ck);
  const root = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const raw = await crypto.subtle.sign('HMAC', root, enc.encode(label));
  const key = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  keyCache.set(ck, key);
  return key;
}

// Deterministic fake salt for usernames that don't exist, so /login/salt does
// not reveal which accounts are real.
export async function fakeSalt(env, usernameLower) {
  const key = await subKey(env, 'gcl-fakesalt-v1');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(usernameLower));
  return b64uEncode(new Uint8Array(sig).slice(0, 16));
}

// ---- tokens ----------------------------------------------------------------
// token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))
// payload = { u: userId, n: username, v: tokenVersion, e: expiry (unix sec) }
export async function signToken(env, { id, username, ver }, ttlSeconds) {
  const exp = nowSec() + ttlSeconds;
  const p = b64uEncode(enc.encode(JSON.stringify({ u: id, n: username, v: ver, e: exp })));
  const key = await subKey(env, 'gcl-token-v1');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(p));
  return { token: p + '.' + b64uEncode(sig), exp };
}

export async function verifyToken(env, token) {
  try {
    if (typeof token !== 'string' || token.length > 600) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [p, s] = parts;
    const key = await subKey(env, 'gcl-token-v1');
    const ok = await crypto.subtle.verify('HMAC', key, b64uDecode(s), enc.encode(p));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
    if (!Number.isInteger(payload.u) || !Number.isInteger(payload.v)) return null;
    if (typeof payload.n !== 'string' || !Number.isInteger(payload.e)) return null;
    if (payload.e <= nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- responses -------------------------------------------------------------
export function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function intVar(env, name, fallback) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
