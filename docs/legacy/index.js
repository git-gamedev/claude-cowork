/**
 * Cloudflare Worker — Auth backend for Tampermonkey auth-gate script.
 *
 * Endpoints:
 *   POST /auth/signup      { username, password } -> { code, token, expiresAt }
 *   POST /auth/login       { username, password } -> { code, token, expiresAt }
 *   POST /session/verify   (Authorization: Bearer <token>) -> { code, username }
 *   POST /session/logout   (Authorization: Bearer <token>) -> { code }
 *   POST /auth/unregister  (Authorization: Bearer <token>) { password } -> { code }
 *   POST /presence/set     (Authorization: Bearer <token>) { server, id } -> { code }
 *   POST /presence/clear   (Authorization: Bearer <token>) [{ server, id }] -> { code }
 *       (with { server, id }: only clears if the stored record still matches,
 *        so a late/stale clear from an old tab can't wipe a newer session)
 *   POST /presence/lookup  (Authorization: Bearer <token>) { server, id } -> { code, username? }
 *
 * KV namespace binding expected: AUTH_KV
 * Secret bindings expected (see setup instructions):
 *   SESSION_HMAC_SECRET  - no longer used for session tokens (kept as a
 *   binding in case a future feature needs HMAC signing; safe to leave set)
 *
 * Security properties:
 *  - Passwords hashed with PBKDF2-SHA256, 100,000 iterations (the maximum
 *    Cloudflare Workers' WebCrypto implementation currently allows —
 *    requesting more throws at runtime), random 16-byte salt.
 *  - Session tokens are opaque, cryptographically random 256-bit values,
 *    stored server-side in KV as session:<token> -> { username, expiresAt }.
 *    A signed token can't be revoked early without a denylist; a KV-backed
 *    opaque token can just be deleted from KV on logout.
 *  - Sessions are delivered in the JSON response body and presented via
 *    an `Authorization: Bearer <token>` header — not cookies. This avoids
 *    cross-origin SameSite/third-party-cookie issues entirely.
 *  - Presence records (presence:<username> -> { server, id, updatedAt })
 *    are stored SEPARATELY from both account records (user:<username>)
 *    and session records (session:<token>), since presence is expected to
 *    be read/written far more frequently than login state — keeping it
 *    in its own key means presence churn never touches credential or
 *    session data. Presence is resolved by username, not by token, so it
 *    survives a session's token being rotated (not currently done, but
 *    keeps the design honest) and is explicitly deleted on logout rather
 *    than left to its own TTL.
 *  - Account creation uses a KV "reservation" pattern to avoid two
 *    concurrent signups silently overwriting each other. See note in
 *    createAccount(). The claim TTL is 60s — Workers KV's enforced minimum
 *    TTL, not a design choice.
 *  - All responses use a small set of generic codes — never reveal whether
 *    a username exists on login failure.
 *  - Basic per-IP rate limiting via a KV counter with TTL on auth routes.
 */

const PBKDF2_ITERATIONS = 100000; // Workers WebCrypto hard cap — do not raise
const SALT_BYTES = 16;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_TOKEN_BYTES = 32; // 256 bits of entropy — opaque, unguessable
const PRESENCE_TTL_SECONDS = 60 * 60 * 24 * 7; // matches session TTL — safety net only; logout deletes explicitly
const PRESENCE_FIELD_MAX_LEN = 128;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const CLAIM_TTL_SECONDS = 60; // Workers KV enforced minimum — do not lower
const BATCH_MAX_IDS = 25; // cap on how many ids one /presence/lookup-batch request can ask for
const BATCH_MAX_CHECKS = 15; // 15 checks (was 60) — the client retries with backoff, so a short hold is enough...
const BATCH_CHECK_INTERVAL_MS = 1000;
const WORKER_VERSION = '1.8-ownership-checks'; // check with: curl -X POST <worker>/version // ...1 second apart = 15s wall-clock cap

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;
// Server names / in-game IDs: printable, no control chars, bounded length.
// Deliberately more permissive than USERNAME_RE since these come from the
// game's own server-name and guest-ID conventions, not ours.
const PRESENCE_FIELD_RE = /^[^\x00-\x1F\x7F]{1,128}$/;

// ---------------------------------------------------------------------
// Utility: consistent JSON responses with a fixed, generic code set
// ---------------------------------------------------------------------

function jsonResponse(code, status, extraBody = {}, extraHeaders = {}) {
  return new Response(JSON.stringify({ code, ...extraBody }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

const CODES = {
  AUTH_OK: () => jsonResponse('AUTH_OK', 200),
  ACCOUNT_CREATED: (token, expiresAt) =>
    jsonResponse('ACCOUNT_CREATED', 201, { token, expiresAt }),
  LOGIN_OK: (token, expiresAt) =>
    jsonResponse('AUTH_OK', 200, { token, expiresAt }),
  LOGGED_OUT: () => jsonResponse('LOGGED_OUT', 200),
  PRESENCE_SET: () => jsonResponse('PRESENCE_SET', 200),
  PRESENCE_CLEARED: () => jsonResponse('PRESENCE_CLEARED', 200),
  INVALID_CREDENTIALS: () => jsonResponse('INVALID_CREDENTIALS', 401),
  ACCOUNT_EXISTS: () => jsonResponse('ACCOUNT_EXISTS', 409),
  INVALID_INPUT: () => jsonResponse('INVALID_INPUT', 400),
  RATE_LIMITED: () => jsonResponse('RATE_LIMITED', 429),
  SERVER_ERROR: () => jsonResponse('SERVER_ERROR', 500),
  NOT_FOUND: () => jsonResponse('SERVER_ERROR', 404),
};

// ---------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltBuf = saltHex ? salt : salt.buffer;
  const finalSaltHex = saltHex || bufToHex(saltBuf);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltHex ? salt : saltBuf,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return { hash: bufToHex(derivedBits), salt: finalSaltHex };
}

async function verifyPassword(password, storedHashHex, storedSaltHex) {
  const { hash } = await hashPassword(password, storedSaltHex);
  return timingSafeEqualHex(hash, storedHashHex);
}

// Constant-time comparison for hex strings of equal expected length.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------
// Session tokens — opaque random values, authoritative record lives in KV.
// ---------------------------------------------------------------------

function generateSessionToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)).buffer);
}

function kvKeyForSession(token) {
  return `session:${token}`;
}

async function createSession(env, username) {
  const token = generateSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const record = JSON.stringify({ username, expiresAt });

  await env.AUTH_KV.put(kvKeyForSession(token), record, {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return { token, expiresAt };
}

async function verifySessionToken(env, token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const stored = await env.AUTH_KV.get(kvKeyForSession(token));
  if (!stored) return null;

  let record;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    return null;
  }

  if (!record.username || !Number.isFinite(record.expiresAt) || record.expiresAt < Date.now()) {
    return null;
  }

  return record;
}

async function deleteSessionToken(env, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  await env.AUTH_KV.delete(kvKeyForSession(token));
}

function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Shared by every route that requires a logged-in user: resolves the
// bearer token to a username, or returns null if invalid/expired.
async function requireAuth(request, env) {
  const token = extractBearerToken(request);
  if (!token) return null;
  const result = await verifySessionToken(env, token);
  return result ? result.username : null;
}

// ---------------------------------------------------------------------
// Presence — server:{ ID: username } bundle, stored separately from
// both credentials (user:<username>) and sessions (session:<token>)
// because it's expected to be read/written far more frequently.
// Keyed by username so it's independent of any particular token.
// ---------------------------------------------------------------------

function kvKeyForPresence(username) {
  return `presence:${username}`;
}

// Reverse index: (server, id) -> username. Lets any logged-in client
// resolve "who is this player I'm currently seeing" without scanning or
// exposing every user's presence record. Kept in sync with the forward
// record on every set/clear — see setPresence/clearPresence.
function kvKeyForPresenceReverse(server, id) {
  // server/id are already validated against PRESENCE_FIELD_RE (no control
  // chars) before this is ever called, so a plain join is safe as a key.
  return `presence_by_id:${server}:${id}`;
}

function validatePresenceInput(server, id) {
  if (typeof server !== 'string' || typeof id !== 'string') return false;
  if (!PRESENCE_FIELD_RE.test(server)) return false;
  if (!PRESENCE_FIELD_RE.test(id)) return false;
  return true;
}

// Delete a reverse-index entry ONLY if it still points at `username`.
// The game recycles player ids, and a stale presence record (tab closed
// without a clear) can name a (server, id) pair that now belongs to someone
// else. Deleting it blindly would erase the NEW owner's entry.
async function deleteReverseIfOwned(env, server, id, username) {
  const key = kvKeyForPresenceReverse(server, id);
  const owner = await env.AUTH_KV.get(key);
  if (owner === username) {
    await env.AUTH_KV.delete(key);
  }
}

async function setPresence(env, username, server, id) {
  // If this user already had a presence record for a DIFFERENT (server, id),
  // drop the old reverse entry — but only if it is still ours.
  const existingRaw = await env.AUTH_KV.get(kvKeyForPresence(username));
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const moved = existing.server !== server || existing.id !== id;
      if (moved && existing.server && existing.id) {
        await deleteReverseIfOwned(env, existing.server, existing.id, username);
      }
    } catch (e) {
      // malformed old record — ignore, we're overwriting it anyway
    }
  }

  // Last writer wins the reverse entry: whoever currently holds (server, id)
  // in-game is the newest claimant, so a stale claim is simply overwritten.
  const record = JSON.stringify({ server, id, updatedAt: Date.now() });
  await env.AUTH_KV.put(kvKeyForPresence(username), record, {
    expirationTtl: PRESENCE_TTL_SECONDS,
  });
  await env.AUTH_KV.put(kvKeyForPresenceReverse(server, id), username, {
    expirationTtl: PRESENCE_TTL_SECONDS,
  });
}

// expected (optional): { server, id }. When given, the record is only cleared
// if it still matches — a late clear from an old tab must not wipe a newer
// session. Returns true if something was cleared.
async function clearPresence(env, username, expected = null) {
  const existingRaw = await env.AUTH_KV.get(kvKeyForPresence(username));
  if (!existingRaw) return false;

  let existing = null;
  try {
    existing = JSON.parse(existingRaw);
  } catch (e) {
    // malformed record — fall through and delete it
  }

  if (
    expected &&
    existing &&
    (existing.server !== expected.server || existing.id !== expected.id)
  ) {
    return false;
  }

  if (existing && existing.server && existing.id) {
    await deleteReverseIfOwned(env, existing.server, existing.id, username);
  }
  await env.AUTH_KV.delete(kvKeyForPresence(username));
  return true;
}

async function lookupPresenceByServerAndId(env, server, id) {
  // cacheTtl 30 is the lowest Workers KV allows (default 60), so a cached
  // "not found" goes stale sooner. It cannot be disabled entirely.
  const username = await env.AUTH_KV.get(kvKeyForPresenceReverse(server, id), {
    cacheTtl: 30,
  });
  return username || null;
}

// ---------------------------------------------------------------------
// Rate limiting (simple fixed-window counter per IP+route)
// ---------------------------------------------------------------------

async function checkRateLimit(env, ip, route) {
  const key = `ratelimit:${route}:${ip}`;
  const current = await env.AUTH_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return false;
  }

  await env.AUTH_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return true;
}

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  if (!USERNAME_RE.test(username)) return false;
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) return false;
  return true;
}

function kvKeyForUser(username) {
  // Case-sensitive by design: "Alice" and "alice" are separate accounts.
  // Do not lowercase this — Xx_ImDaBest_xX deserves its exact casing.
  return `user:${username}`;
}

// ---------------------------------------------------------------------
// Account creation — race-safe against concurrent duplicate signups
//
// This has a race window: two requests for the same new username could
// both pass step 2 before either finishes step 3. To close this without a
// database, we use a placeholder-then-verify pattern:
//   1. Read the key. If present -> ACCOUNT_EXISTS.
//   2. Write a short-lived "claim" record containing a random claimId
//      (TTL = CLAIM_TTL_SECONDS, the lowest Workers KV allows).
//   3. Immediately read the key back.
//   4. If the claimId we read back matches the one we just wrote, we
//      won the race — finalize by overwriting with the real account
//      record (no TTL).
//   5. If it does NOT match, another request won first -> ACCOUNT_EXISTS.
//
// This is not a true atomic CAS (KV is eventually consistent across
// Cloudflare's edge), but it eliminates the common single-region race.
// For hard guarantees at scale, use Durable Objects instead of KV.
// ---------------------------------------------------------------------
async function createAccount(env, username, password) {
  const key = kvKeyForUser(username);

  const existing = await env.AUTH_KV.get(key);
  if (existing !== null) {
    return { ok: false };
  }

  const claimId = bufToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const claimRecord = JSON.stringify({ claim: claimId });

  await env.AUTH_KV.put(key, claimRecord, { expirationTtl: CLAIM_TTL_SECONDS });

  const afterClaim = await env.AUTH_KV.get(key);
  if (afterClaim !== claimRecord) {
    return { ok: false };
  }

  const { hash, salt } = await hashPassword(password);
  const record = JSON.stringify({
    hash,
    salt,
    createdAt: Date.now(),
  });

  await env.AUTH_KV.put(key, record); // no TTL: permanent

  const final = await env.AUTH_KV.get(key);
  if (final !== record) {
    return { ok: false };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleSignup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { username, password } = body || {};
  if (!validateCredentials(username, password)) {
    return CODES.INVALID_INPUT();
  }

  const result = await createAccount(env, username, password);
  if (!result.ok) {
    return CODES.ACCOUNT_EXISTS();
  }

  const { token, expiresAt } = await createSession(env, username);
  return CODES.ACCOUNT_CREATED(token, expiresAt);
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { username, password } = body || {};
  if (!validateCredentials(username, password)) {
    return CODES.INVALID_CREDENTIALS();
  }

  const key = kvKeyForUser(username);
  const stored = await env.AUTH_KV.get(key);

  if (!stored) {
    await hashPassword(password, bufToHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)).buffer));
    return CODES.INVALID_CREDENTIALS();
  }

  let record;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    return CODES.SERVER_ERROR();
  }

  if (!record.hash || !record.salt) {
    return CODES.INVALID_CREDENTIALS();
  }

  const valid = await verifyPassword(password, record.hash, record.salt);
  if (!valid) {
    return CODES.INVALID_CREDENTIALS();
  }

  const { token, expiresAt } = await createSession(env, username);
  return CODES.LOGIN_OK(token, expiresAt);
}

async function handleSessionVerify(request, env) {
  const token = extractBearerToken(request);
  if (!token) {
    return CODES.INVALID_CREDENTIALS();
  }

  const result = await verifySessionToken(env, token);
  if (!result) {
    return CODES.INVALID_CREDENTIALS();
  }

  const stored = await env.AUTH_KV.get(kvKeyForUser(result.username));
  if (!stored) {
    return CODES.INVALID_CREDENTIALS();
  }

  // Include the username so clients can restore display state (e.g. after
  // an auto-login from a stored token) without a separate lookup call.
  return jsonResponse('AUTH_OK', 200, { username: result.username });
}

async function handleLogout(request, env) {
  const token = extractBearerToken(request);
  if (token) {
    const result = await verifySessionToken(env, token);
    await deleteSessionToken(env, token);
    // Presence is explicitly killed on logout, not left to its own TTL.
    if (result && result.username) {
      await clearPresence(env, result.username);
    }
  }
  // Always the same generic response, whether or not a session existed.
  return CODES.LOGGED_OUT();
}

async function handleUnregister(request, env) {
  const token = extractBearerToken(request);
  const username = await requireAuth(request, env);
  if (!username) {
    return CODES.INVALID_CREDENTIALS();
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { password } = body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return CODES.INVALID_INPUT();
  }

  const key = kvKeyForUser(username);
  const stored = await env.AUTH_KV.get(key);
  if (!stored) {
    // Account already gone somehow — treat as success, nothing left to do.
    return CODES.LOGGED_OUT();
  }

  let record;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    return CODES.SERVER_ERROR();
  }

  const valid = await verifyPassword(password, record.hash, record.salt);
  if (!valid) {
    // Re-confirmation failed. Do NOT delete anything.
    return CODES.INVALID_CREDENTIALS();
  }

  // Confirmed. Delete the account record, kill this session, and clear
  // presence. Any *other* still-valid sessions for this user (e.g. logged
  // in on another device) will stop verifying on their next call, since
  // handleSessionVerify checks that the user: record still exists.
  await env.AUTH_KV.delete(key);
  await deleteSessionToken(env, token);
  await clearPresence(env, username);

  return jsonResponse('ACCOUNT_DELETED', 200);
}

async function handlePresenceSet(request, env) {
  const username = await requireAuth(request, env);
  if (!username) {
    return CODES.INVALID_CREDENTIALS();
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { server, id } = body || {};
  if (!validatePresenceInput(server, id)) {
    return CODES.INVALID_INPUT();
  }

  await setPresence(env, username, server, id);
  console.log('presence/set', username, server, id);
  return CODES.PRESENCE_SET();
}

async function handlePresenceClear(request, env) {
  const username = await requireAuth(request, env);
  if (!username) {
    return CODES.INVALID_CREDENTIALS();
  }

  // Optional body { server, id }: clear only if the stored record still
  // matches. No body (or an invalid one) = unconditional clear, as before.
  let expected = null;
  try {
    const body = await request.json();
    if (body && validatePresenceInput(body.server, body.id)) {
      expected = { server: body.server, id: body.id };
    }
  } catch (e) {
    // no/invalid JSON body — unconditional clear
  }

  const cleared = await clearPresence(env, username, expected);
  return cleared
    ? CODES.PRESENCE_CLEARED()
    : jsonResponse('PRESENCE_UNCHANGED', 200);
}

async function handlePresenceLookup(request, env) {
  // Deliberately UNAUTHENTICATED. This is read-only and only ever reveals
  // a username for a player who is (a) currently visible in-game to
  // anyone on that server, and (b) already opted in by logging in and
  // calling /presence/set themselves — a guest target is never findable
  // here, because they never have a presence:/presence_by_id: record to
  // begin with. Requiring a session here gated WHO could ask "who is
  // this," not what the answer reveals, so it added a login requirement
  // with no corresponding privacy benefit — while silently breaking
  // guest viewers, whose otherwise-identical lookup requests carry no
  // Authorization header and were being rejected before ever reaching
  // lookupPresenceByServerAndId.
  //
  // /presence/set, /presence/clear, /auth/unregister, and every other
  // route in this file stay behind requireAuth as before — this is the
  // one read that doesn't need it, not a precedent for loosening others.

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { server, id } = body || {};
  if (!validatePresenceInput(server, id)) {
    return CODES.INVALID_INPUT();
  }

  const username = await lookupPresenceByServerAndId(env, server, id);
  if (!username) {
    return jsonResponse('PRESENCE_NOT_FOUND', 200);
  }

  return jsonResponse('PRESENCE_FOUND', 200, { username });
}

async function handlePresenceLookupBatch(request, env, ctx) {
  // Same trust model as /presence/lookup — deliberately unauthenticated,
  // read-only, reveals nothing that /presence/lookup wouldn't already
  // reveal one id at a time. This just batches many ids into one held-open
  // streaming response instead of many separate round trips, to cut down
  // on client-side request count for a batch of newly-seen player ids.
  //
  // Streams newline-delimited JSON:
  //   {"done":false,"found":[{"id":"...","username":"..."}, ...]}   (zero or more, as ids resolve)
  //   {"done":true,"unresolved":["...", ...]}                       (always exactly one, last line)
  //
  // Polls at most BATCH_MAX_CHECKS times, BATCH_CHECK_INTERVAL_MS apart.
  // Whatever hasn't resolved by then comes back in the final line's
  // "unresolved" list — caller is expected to re-submit those later.
  // Overlapping concurrent batch requests (including ones covering the
  // same ids) are expected and fine — each is independent server-side.

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return CODES.INVALID_INPUT();
  }

  const { server, ids } = body || {};
  if (
    typeof server !== 'string' ||
    !PRESENCE_FIELD_RE.test(server) ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > BATCH_MAX_IDS ||
    !ids.every((id) => typeof id === 'string' && PRESENCE_FIELD_RE.test(id))
  ) {
    return CODES.INVALID_INPUT();
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamBody = (async () => {
    const remaining = new Set(ids);

    try {
      for (let check = 0; check < BATCH_MAX_CHECKS && remaining.size > 0; check++) {
        const found = [];

        for (const id of remaining) {
          const username = await lookupPresenceByServerAndId(env, server, id);
          if (username) found.push({ id, username });
        }

        if (found.length > 0) {
          for (const f of found) remaining.delete(f.id);
          await writer.write(encoder.encode(JSON.stringify({ done: false, found }) + '\n'));
        }

        if (remaining.size === 0) break;
        await new Promise((resolve) => setTimeout(resolve, BATCH_CHECK_INTERVAL_MS));
      }

      console.log('lookup-batch done', server, 'ids', ids.join(','), 'unresolved', [...remaining].join(','));
      await writer.write(
        encoder.encode(JSON.stringify({ done: true, unresolved: [...remaining] }) + '\n')
      );
    } catch (e) {
      // Best-effort: if the client disconnected mid-stream, writer.write
      // will throw — nothing more to do, just stop looping.
    } finally {
      try {
        await writer.close();
      } catch (e) {
        // already closed/errored — ignore
      }
    }
  })();

  // The polling loop must keep running after this function returns its
  // (already-streaming) Response, or the Workers runtime may tear down
  // the invocation before the background writes finish. waitUntil keeps
  // it alive for exactly that purpose.
  ctx.waitUntil(streamBody);

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------
// CORS — restrict to the specific target site(s) using this script.
// ---------------------------------------------------------------------

const ALLOWED_ORIGINS = [
  'https://gats.io',
  // add additional origins as needed
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return withCors(CODES.NOT_FOUND(), cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    try {
      if (url.pathname === '/version') {
        return withCors(jsonResponse('VERSION', 200, { version: WORKER_VERSION }), cors);
      }

      if (url.pathname === '/auth/signup') {
        const allowed = await checkRateLimit(env, ip, 'signup');
        if (!allowed) return withCors(CODES.RATE_LIMITED(), cors);
        return withCors(await handleSignup(request, env), cors);
      }

      if (url.pathname === '/auth/login') {
        const allowed = await checkRateLimit(env, ip, 'login');
        if (!allowed) return withCors(CODES.RATE_LIMITED(), cors);
        return withCors(await handleLogin(request, env), cors);
      }

      if (url.pathname === '/session/verify') {
        return withCors(await handleSessionVerify(request, env), cors);
      }

      if (url.pathname === '/session/logout') {
        return withCors(await handleLogout(request, env), cors);
      }

      if (url.pathname === '/auth/unregister') {
        return withCors(await handleUnregister(request, env), cors);
      }

      if (url.pathname === '/presence/set') {
        return withCors(await handlePresenceSet(request, env), cors);
      }

      if (url.pathname === '/presence/clear') {
        return withCors(await handlePresenceClear(request, env), cors);
      }

      if (url.pathname === '/presence/lookup') {
        return withCors(await handlePresenceLookup(request, env), cors);
      }

      if (url.pathname === '/presence/lookup-batch') {
        return withCors(await handlePresenceLookupBatch(request, env, ctx), cors);
      }

      return withCors(CODES.NOT_FOUND(), cors);
    } catch (err) {
      return withCors(CODES.SERVER_ERROR(), cors);
    }
  },
};

function withCors(response, cors) {
  const newHeaders = new Headers(response.headers);
  Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}