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
