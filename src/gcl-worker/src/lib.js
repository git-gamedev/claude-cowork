// Shared helpers: base64url, HMAC tokens, PBKDF2 password hashing.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- tokens: base64url(JSON claims) + "." + base64url(HMAC-SHA256) ---------

const keyCache = new Map();
async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error('TOKEN_SECRET missing or too short');
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, k);
  }
  return k;
}

export async function signToken(secret, claims) {
  const body = b64u(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64u(sig);
}

// Returns the claims object, or null if the token is malformed, forged or expired.
export async function verifyToken(secret, token) {
  try {
    if (typeof token !== 'string' || token.length > 1000) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(unb64u(parts[0])));
    if (!claims || typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
    if (typeof claims.u !== 'string' || typeof claims.v !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}

// ---- misc ------------------------------------------------------------------

export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Constant-time string comparison (compares fixed-length digests).
export async function safeEqStr(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  return eqBytes(new Uint8Array(da), new Uint8Array(db));
}

// ---- passwords: PBKDF2-SHA256 ----------------------------------------------
// Stored format: pbkdf2$<iterations>$<salt b64u>$<hash b64u>
// Workers caps PBKDF2 at 100000 iterations.

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64u(salt)}$${b64u(hash)}`;
}

export async function checkPassword(password, stored) {
  try {
    const [alg, it, s, h] = String(stored).split('$');
    const iterations = parseInt(it, 10);
    if (alg !== 'pbkdf2' || !(iterations >= 1000 && iterations <= 100000)) return false;
    const got = await pbkdf2(password, unb64u(s), iterations);
    return eqBytes(got, unb64u(h));
  } catch {
    return false;
  }
}

// Burn the same CPU for unknown usernames so timing doesn't reveal which accounts exist.
export async function dummyCheck(password, iterations) {
  await pbkdf2(password, new Uint8Array(16), iterations);
}
