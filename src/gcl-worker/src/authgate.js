// AuthGate: does the CPU-heavy password hashing and keeps brute-force counters.
//
// Why a Durable Object? The Workers free plan allows ~10 ms CPU per request,
// which PBKDF2 at 100k iterations can exceed. Durable Objects are not held to
// that cap, so hashing here is safe on the free tier.
//
// Counters live in memory only. They reset if the object is evicted, which is
// acceptable for best-effort throttling (the PBKDF2 cost is the real defence).

import { DurableObject } from 'cloudflare:workers';
import { hashPassword, checkPassword, dummyCheck } from './lib.js';

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const REG_WINDOW_MS = 60 * 60 * 1000;
const MAX_USER_FAILS = 5;     // per username per 15 min
const MAX_IP_FAILS = 20;      // per IP per 15 min
const MAX_REG_PER_IP = 5;     // register attempts per IP per hour

// Shared by the DO and by the in-Worker fallback (HASH_MODE=worker).
export async function gateOp(mem, body, iterations) {
  const now = Date.now();
  const get = (k) => {
    const e = mem.get(k);
    if (!e || e.reset < now) { mem.delete(k); return 0; }
    return e.n;
  };
  const inc = (k, win) => {
    const e = mem.get(k);
    if (!e || e.reset < now) mem.set(k, { n: 1, reset: now + win });
    else e.n++;
  };
  if (mem.size > 5000) {
    for (const [k, e] of mem) if (e.reset < now) mem.delete(k);
    if (mem.size > 5000) mem.clear();
  }

  const ip = String(body.ip || '');
  const password = String(body.password || '');

  if (body.op === 'hash') {
    if (get('r:' + ip) >= MAX_REG_PER_IP) return { locked: true };
    inc('r:' + ip, REG_WINDOW_MS);
    return { hash: await hashPassword(password, iterations) };
  }

  if (body.op === 'verify') {
    const uk = 'u:' + body.user;
    const ik = 'i:' + ip;
    if (get(uk) >= MAX_USER_FAILS || get(ik) >= MAX_IP_FAILS) return { locked: true };
    let ok = false;
    if (body.stored) ok = await checkPassword(password, body.stored);
    else await dummyCheck(password, iterations);
    if (ok) { mem.delete(uk); return { ok: true }; }
    inc(uk, FAIL_WINDOW_MS);
    inc(ik, FAIL_WINDOW_MS);
    return { ok: false };
  }

  return { error: 'bad_op' };
}

export class AuthGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mem = new Map();
  }

  async fetch(request) {
    const body = await request.json();
    const iterations = Math.min(100000, parseInt(this.env.PBKDF2_ITERATIONS || '100000', 10) || 100000);
    const out = await gateOp(this.mem, body, iterations);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
}
