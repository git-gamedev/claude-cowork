// Verifier: pending email code for ONE account (Durable Object, one per uid).
// Holds only the HMAC of the code (never the code), its expiry, the wrong-guess count and the recent send times.
// Hot, short-lived state: nothing here touches D1.
//
//   /put?h=<hash>   store a new code; 429 {error: cooldown | too_many_sends, retryAfter}
//   /check?h=<hash> -> {status: ok | wrong | dead | none, left}
//                      ok = match (code consumed), wrong = mismatch (counted), dead = 5th wrong, code destroyed,
//                      none = no live code (expired or never sent). Wrong guesses never lock the ACCOUNT:
//                      the only consequence is that this one code dies and a new one must be requested.
//   /clear          drop the live code (e.g. the email could not be sent), keeps the send history

import { DurableObject } from 'cloudflare:workers';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_TRIES = 5;
export const COOLDOWN_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 5;
const HOUR = 3600 * 1000;
const H = { 'content-type': 'application/json' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: H });

export class Verifier extends DurableObject {
  async fetch(request) {
    const u = new URL(request.url);
    const now = Date.now();
    const s = (await this.ctx.storage.get('s')) || { sends: [] };
    s.sends = s.sends.filter((t) => t > now - HOUR);
    const live = s.h && s.exp > now;

    switch (u.pathname) {
      case '/put': {
        const last = s.sends[s.sends.length - 1];
        if (last && now - last < COOLDOWN_MS) return reply({ error: 'cooldown', retryAfter: Math.ceil((COOLDOWN_MS - (now - last)) / 1000) }, 429);
        if (s.sends.length >= MAX_SENDS_PER_HOUR) return reply({ error: 'too_many_sends', retryAfter: Math.ceil((s.sends[0] + HOUR - now) / 1000) }, 429);
        s.sends.push(now);
        s.h = u.searchParams.get('h');
        s.exp = now + CODE_TTL_MS;
        s.tries = 0;
        await this.ctx.storage.put('s', s);
        await this.ctx.storage.setAlarm(now + HOUR + 1000);
        return reply({ ok: true });
      }
      case '/check': {
        if (!live) return reply({ status: 'none' });
        if (u.searchParams.get('h') === s.h) {
          delete s.h; delete s.exp; delete s.tries;
          await this.ctx.storage.put('s', s);
          return reply({ status: 'ok' });
        }
        s.tries = (s.tries || 0) + 1;
        if (s.tries >= MAX_TRIES) {
          delete s.h; delete s.exp; delete s.tries;
          await this.ctx.storage.put('s', s);
          return reply({ status: 'dead', left: 0 });
        }
        await this.ctx.storage.put('s', s);
        return reply({ status: 'wrong', left: MAX_TRIES - s.tries });
      }
      case '/clear':
        delete s.h; delete s.exp; delete s.tries;
        await this.ctx.storage.put('s', s);
        return reply({ ok: true });
      default:
        return reply({ error: 'not_found' }, 404);
    }
  }

  // Leave no rows behind for idle accounts: once the send history has aged out and no code is live, wipe.
  async alarm() {
    const s = await this.ctx.storage.get('s');
    const now = Date.now();
    if (s && (s.sends || []).some((t) => t > now - HOUR)) { await this.ctx.storage.setAlarm(now + HOUR); return; }
    await this.ctx.storage.deleteAll();
  }
}
