// Gate: tiny fixed-window counter, one Durable Object per key (IP /64, login, or a global key).
//
// Why persisted: an in-memory counter vanishes when the DO is evicted (about a minute idle),
// so a patient attacker would always see an empty window. We write ONE small record per
// window and only on counted events (failures / registrations), and stop writing once the
// key is locked, so an attacker cannot turn this into a storage-write flood.
//
// Endpoints (query: limit, win in seconds):
//   /check -> {n, locked}      read-only
//   /try   -> reserves one in-flight slot (memory only); 429 when n + in-flight >= limit.
//              Closes the check-then-fail race: N parallel guesses can no longer all pass a
//              read-only /check before the first /fail lands. Must be followed by /fail (wrong
//              password), /ok (success) or /done (abandoned). Unreleased slots expire after 30 s.
//   /done  -> releases one /try slot without counting a failure
//   /hit   -> counts every call; 429 once n >= limit        (register, rename, global cap)
//   /fail  -> counts a failure; 429 once n >= limit          (bad passwords)
//   /ok    -> clears the counter                             (successful login)

import { DurableObject } from 'cloudflare:workers';

// Normalise a client address into a throttle key. IPv6 users can rotate through a whole /64
// for free, so every address in the same /64 shares one key.
export function ipKey(ip) {
  ip = String(ip || 'unknown').toLowerCase();
  if (!ip.includes(':')) return ip;                          // IPv4 or 'unknown'
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // ::ffff:1.2.3.4 -> 1.2.3.4
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const PENDING_TTL_MS = 30000;
const GATE_HEADERS = { 'content-type': 'application/json' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: GATE_HEADERS });

export class Gate extends DurableObject {
  // In-flight reservations (timestamps). Memory only: a live request keeps the object resident, and a
  // leaked slot is dropped by the TTL or by eviction, so nothing extra is ever written to storage.
  prune() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this.pending = (this.pending || []).filter((t) => t > cutoff);
  }

  release() {
    this.prune();
    this.pending.shift();
  }

  async load() {
    if (this.rec === undefined) this.rec = (await this.ctx.storage.get('r')) || null;
    if (this.rec && this.rec.reset <= Date.now()) this.rec = null;
    return this.rec;
  }

  async fetch(request) {
    const u = new URL(request.url);
    const limit = Number(u.searchParams.get('limit')) || 10;
    const win = (Number(u.searchParams.get('win')) || 900) * 1000;
    let rec = await this.load();
    const n = rec ? rec.n : 0;

    switch (u.pathname) {
      case '/check':
        return reply({ n, locked: n >= limit });
      case '/try': {
        this.prune();                      // no await between this check and the push: atomic
        if (n + this.pending.length >= limit) return reply({ n, locked: true }, 429);
        this.pending.push(Date.now());
        return reply({ n, locked: false });
      }
      case '/done':
        this.release();
        return reply({ n, locked: n >= limit });
      case '/ok':
        this.release();
        if (rec) { this.rec = null; await this.ctx.storage.deleteAll(); }
        return reply({ n: 0, locked: false });
      case '/hit':
      case '/fail':
        if (u.pathname === '/fail') this.release(); // a /try reservation becomes a counted failure
        if (n >= limit) return reply({ n, locked: true }, 429); // locked: no further writes
        rec = rec || { n: 0, reset: Date.now() + win };
        rec.n++;
        this.rec = rec;
        await this.ctx.storage.put('r', rec);
        if (rec.n === 1) await this.ctx.storage.setAlarm(rec.reset); // cleanup so idle keys leave no rows
        return reply({ n: rec.n, locked: u.pathname === '/fail' && rec.n >= limit });
      default:
        return reply({ error: 'not_found' }, 404);
    }
  }

  async alarm() {
    const r = await this.ctx.storage.get('r');
    if (r && r.reset > Date.now()) { await this.ctx.storage.setAlarm(r.reset); return; }
    this.rec = null;
    await this.ctx.storage.deleteAll();
  }
}
