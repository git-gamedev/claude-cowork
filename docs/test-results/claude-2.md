# claude-2 (researcher): independent read of gats-community.user.js vs worker.js/room.js (issue #29)

Base: main @ 9632c1d. Method: read-only code review of the userscript (641 lines), cross-checked against
src/worker.js and src/room.js and docs/reference/gats-protocol-reference.md.
Ran: `npm test` (# tests 27 # pass 27 # fail 0 ) and `node scratch/claude-1/replay.mjs` (PASS=9 FAIL=0), both Node-only.
NOT run: workerd, a real browser/Tampermonkey, the live game. Every finding below is from reading, not reproduced.

## Contract checks that match
- Token claims uid/name and exp in ms: client and worker agree (worker.js session()).
- Presence subprotocol ['gcl.v1', token] and ?room= match worker.js presence route.
- Close codes: 4000 (replaced) and 4002 (revoked) handled; 4001 (timeout/no state) falls through to backoff reconnect, which is fine.

## Findings (most important first)
1. UX bug (confirmed by reading): /rename returns 429 {error:'rename_cooldown', retryAfter}; client ERRORS has no entry,
   so the user sees "Something went wrong". Fix: add message using retryAfter.
2. Security/docs: the login form lives in the page DOM. Game or ad scripts can read #gcl-p or use capture-phase key
   listeners; GM_setValue only protects the token, not the typed password. A closed shadow root helps only partially
   (key events are composed). Suggest: closed shadow root + INSTRUCTIONS.md note to use a password not reused elsewhere.
3. Low: presence onclose is not guarded against a stale socket. After a room change the old socket's close runs
   clearInterval(hbTimer) (shared variable, may kill the NEW socket's heartbeat), schedule() (bumps retries, can trigger
   auth.refresh at retries===3) and, for code 4000, sets want=false. Self-heals via server 4001 timeout + reconnect, but wastes
   requests. Fix: per-socket timer and an early `if (sock !== s) return` after clearing its own timer.
4. Low, unverified: String.fromCharCode.apply on a very large buffer (~>100 KB) throws RangeError; the outer catch forwards the
   original event, so hooks silently skip that batch (missed d frames). Fix: decode in chunks. Needs real frame sizes.
5. Low: transformer sets p[18] on 'a' frames without checking p.length > 18; a short frame would be padded with empty fields.
6. Needs a real browser: unsafeWindow.WebSocket replaced by a sandbox function (Firefox/Xray behaviour unknown); assumption that
   the game uses binaryType arraybuffer; whether the injected re-init 'd' frame triggers spawn effects in the game.
7. Info: 'login' event fires on every refresh/rename, so hello is re-sent; harmless.

---
# Fixes and verification (claude-2, took an implementer slice on user instruction), main @ 7435a16

Merged with concurrent work by other instances: #32 reserved-name normalisation (e9fd6f6) and #41 rename_cooldown message (b4e1167) were
landed by others while I worked; I kept their versions and added only the parts that were missing.

## What changed (commit 7435a16)
- #31 Gate TOCTOU: new `/try` endpoint reserves an in-flight slot atomically (memory only, 30 s TTL); `/fail`, `/ok`, `/done` release it.
  worker.js login() now calls `/try` on the IP and account Gates instead of the read-only `/check`, then `/fail` (wrong password) or
  `/done` + `/ok` (success). No extra storage writes; failures are still the only thing persisted.
- Userscript (from my #29 review): stale presence socket can no longer stop the new socket's heartbeat or bump the retry counter;
  'a'-frame own-name rewrite now requires p.length > 18.
- Tests: +2 Gate unit tests, +3 parallel-burst e2e tests, +1 reserved-name e2e test. Suite is now 34 tests.

## Evidence
- Node: `npm test` 34/34 (28/34 before the fix: the 5 new tests failed, reproducing the overshoot and the bypass); replay 9/9.
- REAL workerd (wrangler 4.x `dev --local`, local D1, real DOs), copy of src/gats-community in /tmp at 7435a16, scripts from scratch/claude-3:
  - burst.mjs: 200 parallel wrong guesses, distinct IPs, one account -> {401:10, 429:190} (before: 20 passed in claude-3's run).
  - burst.mjs / burst-ip.mjs: one IP, parallel unknown users, N=30..200, 6 trials -> exactly 20x401, rest 429 every time (before: 30/30 to 200/200 passed).
  - fifth-1 smoke-canonical-gats-community.mjs: 22/22. Two local adjustments to the script, not committed: ADMIN_KEY set to the script's
    value, and the "gate" loop raised from 12 to 25 tries because the IP limit is 20 (the earlier 21/22 was that stale expectation).
  - Reserved names on workerd: admin. / ad-min / a_d.m-i_n / adm1n / m0derator / gats_io / Gatsio / sy5tem / off1cial / r00t / admin2 -> 409;
    adam / modest / rooty -> 200. Rename twice -> 200 then 429 {error:rename_cooldown, retryAfter:86400}.

## Trade-offs and limits
- A successful login now costs 4 Gate DO requests (try x2, done, ok) instead of 2-3. Logins are rare (7-day token), so the 100k/day DO request cap is not affected in practice.
- Parallel in-flight attempts count against the limit: more than 10 simultaneous logins for one account, or 20 from one IP, get 429 even if they would succeed.
- Lockout griefing (10 wrong guesses lock an account for 15 min) is unchanged and remains an accepted limit.
- Still NOT tested: real Cloudflare deploy, browser/Tampermonkey (the userscript edits are syntax-checked and replay-tested only), live game.
- Reserved-name check is exact-match after normalisation, so impersonation like "admin_official" or "TheAdmin" is still possible.
