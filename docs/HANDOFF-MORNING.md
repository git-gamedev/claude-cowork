# HANDOFF for the next instances (written by claude-1 at the end of night 1, 2026-10-25)

Read this first, then STATE.md, then issue #1 and #25. This file is the map; it is meant to be enough for a fresh instance (Claude, ChatGPT or other) to continue without the chat history.
Nothing below claims production readiness: **nothing has ever run on a real Cloudflare account, in a real browser/Tampermonkey, or against the live game.** All tests are local Node harnesses.

## 1. What this project is
A free-tier login + presence system for the browser game gats.io, owned by the user (repo owner: git-gamedev). Deliverables: Tampermonkey userscript, Cloudflare Worker `login-info-handler`, Durable Objects, D1 schema, detailed instructions. The user already has a deployed worker named `login-info-handler` (old KV-based version) at https://login-info-handler.gitgames.workers.dev and will overwrite it with this code.

## 2. Canonical code (only this tree is real)
`src/gats-community/`
| File | Role |
|---|---|
| `gats-community.user.js` | Tampermonkey script. 4 modules: auth_ui (GM_setValue token, PBKDF2 600k client-side, login/register/account UI), ws_hook (taps the game's WebSocket via unsafeWindow), presence_client (ONE WebSocket to /presence, token in subprotocol, ping every 25 s, backoff, gives up after ~8 failures), hook_handler (decodes a/b/c/d/e/s frames, swaps names, injects rebuilt d+c frames). |
| `src/worker.js` | Stateless front door. Routes: GET /health, POST /register /login /refresh /rename /admin/ban, GET /presence (WebSocket). HMAC-signed tokens (two key slots: TOKEN_SECRET and PEPPER), 2 KB body cap, origin and room allowlists. |
| `src/room.js` | Durable Object `Room`, one per game server host. Hibernating WebSockets, per-wake index, 5-minute alarm revalidates bans/token versions against D1 (batched), bounded user cache (256). |
| `src/gate.js` | Durable Object `Gate`: persisted fixed-window counters (login failures per IP /64 and per account, register per IP and global per day, rename per IP). Fails open. |
| `schema.sql`, `schema_002.sql` | D1 tables `users`, `events`; migration adds `users.renamed_at`. Apply base once, then 002 once. |
| `wrangler.toml` | Bindings DB/ROOMS/GATE, vars ALLOWED_ORIGINS, ROOM_REGEX, ALLOWED_ROOM_SUFFIX ("gats.io" is a GUESS), MAX_REG_PER_DAY (300). `database_id` is a placeholder the user must fill. |
| `INSTRUCTIONS.md` | The user-facing setup guide (deploy, secrets, hostname check, smoke test, Gate limits, troubleshooting). |
| `tests/`, `package.json` | `npm test` = 27 tests (Node 20.6+; fake D1 + fake DO runtime). |

Donor/reference trees, do NOT deploy or extend: `src/gats-login/`, `src/gcl-worker/`.
Other places: `docs/` (reviews, cost, tests, legacy, reference), `scratch/<name>/` (per-agent harnesses and benches; throwaway but reproducible), `docs/reference/` + `docs/gats-protocol.md` (the game wire protocol, verbatim from the user), `docs/legacy/` + `docs/legacy-v1.8-digest.md` (old KV worker and old userscript lessons).

## 3. Key design decisions (do not silently reverse)
1. Password is stretched client-side (PBKDF2-SHA256, 600k); the Worker only HMACs the derived key with PEPPER. Reason: Workers free plan has ~10 ms CPU per request.
2. `login` (immutable lowercase id, also the KDF salt) is separate from `username` (display name, renamable, 24 h cooldown, reserved names rejected).
3. Token lives in GM storage, not page storage; presence token travels in the WebSocket subprotocol, not the URL.
4. One presence WebSocket per account per room; heartbeat is the literal text `ping`, answered by the runtime auto-response without waking the DO.
5. D1 is written rarely (register, rename, ban, capped login audit). Failed logins never write D1; they hit the Gate DO.
6. Community names are applied only when the claimed in-game name (`gname`) equals the game's own d-frame username. This is NOT authentication; a client can still claim any in-game name (issue #11 residual risk, documented).
7. `ALARM_MS` = 300000 because every alarm is a Durable Object request against the 100,000/day free cap (docs/cost-estimate.md).

## 4. Status of work (verify against `git log` and the issue list, they move)
Done and covered by local tests: ban/revalidation after hibernation (#8), Gate throttle persisted (#9, with known limits), rename cooldown/reserved names/registration cap (#10), phantom ghosts and blank d injection (#12), stale chat-bubble replay (#24), allocation/CPU optimizations (docs/optimization-sonnet-1.md), cost model (docs/cost-estimate.md), INSTRUCTIONS.md fixes (#26).
Open on purpose (need real runs or the user): see section 5.

## 5. What still needs a real run or the user
Mark these with label `testing`; they cannot be closed from a sandbox.
- Deploy to a real Cloudflare account and run the smoke checklist in INSTRUCTIONS.md.
- Run the suite in real workerd (`wrangler dev --local`); fifth-1's scratch tree has a workerd smoke run (22/22 on an earlier SHA) but the current canonical code with the optimizations has NOT been re-run there.
- Parallel-burst failed logins against real workerd (critic's #9 TOCTOU repro is only a model: docs/review-claude-sonnet-round3.md, scratch/claude-sonnet/toctou-gate.mjs).
- The userscript in a real browser with Tampermonkey on gats.io (decoded-frame logic is replay-tested only: `node scratch/claude-1/replay.mjs`).
- The user must confirm the real game WebSocket hostnames and set `ALLOWED_ROOM_SUFFIX`; the userscript logs `[gcl] presence room: <host>` to help.
- Known accepted limits: lockout griefing of a single account (10 failures/15 min), account existence leak after 10 failures, many-IP spraying, unauthenticated in-game identity claims.

## 6. How to work in this repo (relay rules that bit us)
- The original relay participant file is not stored in the repo; summary: setup `~/relay.sh` helpers (list/comment/open/label/close issues via the GitHub API), claim issues with `owner:<name>` labels, comments under 150 words and tagged `[name/role]`, no tokens in text, issue #1 closed only by the planner/user, bugs only if reproduced (cap 3 per session).
- `docs/CLEANUP.md` is the current protocol: announce `CLAIM #N` / `DONE #N` / `RELEASE #N` / `HELP #N need K helpers` in issue #25, never close an issue without verifying at HEAD and putting the evidence (commit, command, result) in the closing comment.
- Practical traps seen on night 1: the sandbox `sh` has no `source`, run helpers with `bash -c`; set `git config user.name/email` before the first commit or the commit silently fails and your reported SHA is wrong; pushes race, so loop `git pull --rebase` + `git push` and then verify `git rev-parse HEAD == origin/main` BEFORE quoting a SHA; two agents optimized the same files in parallel and collided, so claim first and keep edits small.
- Run `cd src/gats-community && npm test` before and after any change to `src/`. Report only what you actually ran and how.
- **Secrets:** the two GitHub tokens used by the relay were pasted into chats by the user. They should be rotated by the user. Never write tokens or Cloudflare secrets into any file, issue or comment.

## 7. Suggested first moves tomorrow (in order)
1. `git pull`; run `npm test`; run `node scratch/claude-1/replay.mjs` (expect 27/27 and 9/9).
2. Read open issues; anything not labelled `testing` should be verified and closed per CLEANUP.md or fixed.
3. If the user supplied hostnames or a workerd/Cloudflare result, fold them in: update `wrangler.toml`, INSTRUCTIONS.md, STATE.md.
4. Re-run fifth-1's workerd smoke test on current HEAD (see scratch/fifth-1/README.md).
5. Only the planner role (or the user) posts DONE on #1 and closes it, and only after real-run items in section 5 are checked off.

## 8. Notes for the ChatGPT cleanup pass
- You do not need to re-derive anything: this file, STATE.md, `docs/CLEANUP.md` and the issue list are the full context.
- Safe cleanup: verify and close duplicates (#17/#22, #18-#23 overlaps) only with evidence; update STATE.md; keep `testing` issues open; do not delete files under `docs/` or `scratch/` (they are evidence); do not edit `src/` without running `npm test`; do not touch donor trees.
- If something here contradicts the code at HEAD, trust the code and fix this file.
