// Shared helpers: encoding, HMAC, signed tokens, validation, JSON/CORS responses.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export const LIMITS = {
  MIN_ITER: 200000,
  MAX_ITER: 1000000,
  DEFAULT_ITER: 310000,
  LOCK_AFTER: 8,                       // failed attempts before lockout
  LOCK_MS: 10 * 60 * 1000,
  RENAME_COOLDOWN_MS: 24 * 3600 * 1000,
  SIGNUPS_PER_IP_PER_HOUR: 3,
};

export const RE = {
  username: /^[A-Za-z0-9_]{3,15}$/,
  salt: /^[A-Za-z0-9_-]{22}$/,         // 16 bytes, base64url
  key: /^[A-Za-z0-9_-]{43}$/,          // 32 bytes, base64url
  room: /^[a-z0-9.-]{3,80}(:\d{1,5})?$/,
};

const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'system', 'gats', 'staff', 'server', 'support'];
export function isReserved(lc) {
  return RESERVED.includes(lc) || lc.startsWith('admin');
}

// ---------- HMAC / constant-time compare ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmac(secret, data) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- tokens: v1.<payload>.<signature>, no database needed to verify ----------

export async function signToken(env, payload) {
  const body = b64u.enc(enc.encode(JSON.stringify(payload)));
  const sig = b64u.enc(await hmac(env.TOKEN_SECRET, 'v1.' + body));
  return `v1.${body}.${sig}`;
}

export async function verifyToken(env, token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = b64u.enc(await hmac(env.TOKEN_SECRET, 'v1.' + parts[1]));
  if (!safeEqual(expected, parts[2])) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64u.dec(parts[1])));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== 'string' || !payload.exp || Date.now() >= payload.exp) return null;
  return payload;
}

// ---------- server-side secrets applied to client-derived material ----------

export async function pwHash(env, clientKey) {
  return b64u.enc(await hmac(env.PEPPER, 'pw1|' + clientKey));
}

// Same input always gives the same fake salt, so unknown usernames look like real ones.
export async function fakeSalt(env, lc) {
  return b64u.enc((await hmac(env.PEPPER, 'salt|' + lc)).slice(0, 16));
}

export async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return b64u.enc((await hmac(env.PEPPER, 'ip|' + ip)).slice(0, 12));
}

// ---------- HTTP helpers ----------

export function cors(request) {
  return {
    'Access-Control-Allow-Origin': 'https://gats.io',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request) },
  });
}

export async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 4096) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}
