# Legacy userscript v1.8 (KV-backed) — digest for review

Source: file the user uploaded in claude-1's chat ("gats.io Community Login + Presence", @version 1.8, `@grant none`). This is a DIGEST written by claude-1, not a verbatim copy; the ws_hook module in it is identical to the skeleton already in the repo. The user can paste the full file if anyone needs exact text.

## Backend contract it expects (worker `login-info-handler`, KV era)
| Call | Body | Result handled |
|---|---|---|
| POST /auth/login | {username,password} | 200 {token,expiresAt}; 429 too many; else "bad credentials" |
| POST /auth/signup | {username,password} | 201 {token,expiresAt}; 409 taken; 429; else invalid |
| POST /session/verify | Bearer token | 200 {username} (auto-login on page load) |
| POST /session/logout | Bearer token | fire-and-forget |
| POST /auth/unregister | Bearer + {password} | 200 deletes; 401 wrong password |
| POST /presence/set | Bearer + {server,id} | records "this account is player <id> on <server>" |
| POST /presence/clear | Bearer + {server,id}, keepalive | on socket close and pagehide |
| POST /presence/lookup | {server,id} (no auth) | {code:"PRESENCE_FOUND",username}; retried up to 5x on errors |
| POST /presence/lookup-batch | {server,ids[<=25]} (no auth) | NDJSON stream: {found:[{id,username}]} lines, then {done:true,unresolved:[...]} |

## Design points worth keeping
- Username validation hint: 3-32 chars letters/numbers/_ (canonical tree now uses 3-16, no commas/pipes).
- Delete-account UX: swipe-to-confirm thumb, then password re-entry. Server password check is the real gate.
- Name injection: rewrites self `a` frame field 18 (username) and re-emits `d`+`c` frames for others once a real `c` frame exists (otherwise the body circle vanishes because blank = "unchanged" in delta frames).
- Lookup throttling: IN_FLIGHT set, per-id RETRY_AT with backoff 5s -> 30s, ATTEMPTS counter; added because `d` is re-sent whenever a player re-enters view and guests never resolve.
- `checkLazyIDs()` on every `s` (despawn) frame re-verifies known names one HTTP call per id.

## Flaws that explain the DDoS / restart (lessons for the canonical tree)
1. Token in `localStorage` with `@grant none`: any page script can read it. Canonical plan: GM_setValue.
2. Lookups are unauthenticated and per-id HTTP: `lookup-batch` holds a streaming response open up to 60 s per batch, and `checkLazyIDs` fires N sequential requests per despawn. Cheap for an attacker or a busy server to multiply; each one is a Worker request against the 100k/day free cap. Presence over ONE WebSocket (canonical design) removes this.
3. Presence is claimed by the client (`id` is self-reported): any account can claim any in-game id. Same residual risk as issue #11.
4. `/presence/set` + `/presence/clear` on every join/leave/pagehide = two writes per session on KV (1,000 writes/day free), which matches the reported AUTH_KV exhaustion.
5. Passwords are sent to the worker raw (server-side hashing under a 10 ms CPU cap). Canonical tree derives a key client-side (PBKDF2) instead.
6. Verbose `[gcl-trace]` console logging of frames and ids in production.
7. No retry cap on `/auth/login` UI beyond a 429 message; no rename feature in this file despite the description.

## Compare with canonical `src/gats-community`
Everything above maps to: one `/presence` WebSocket, token verified by the worker, DO-held roster, D1 for accounts, Gate DO for throttling. Items 3 and 5 are the ones still open/different (see #11 and INSTRUCTIONS.md).
