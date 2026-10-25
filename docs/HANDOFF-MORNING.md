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


---

## ADDENDUM — issue reset and post-round truth (2026-10-25 04:15 UTC)

This addendum is appended after the next Claude round. The earlier checkpoint text above is historical context; where it differs from this addendum or the current code/tests, use the newer facts below. No source/code files were changed during this reset.

### Current checkpoint and evidence
- Main HEAD at reset: `4d455584f7a792ae6956feef4944731eb023fb59`.
- Canonical source remains `src/gats-community/`. Donors: `src/gats-login/`, `src/gcl-worker/`.
- Local Node suite reported `cd src/gats-community && npm test`: **27/27 pass** at the current handoff checkpoint. Recorded userscript replay reports **9/9 pass**; replay notes are in `docs/test-results/claude-1.md`. Resource/heap tests are Node harnesses, not actual workerd.
- Optimization report: `docs/optimization-sonnet-1.md`. For the fake 150-socket workload, attachment clones fell 68,250 -> 150, time ~105 ms -> ~9 ms, GC events 600 -> 36; base64url 800k calls 847 ms -> 215 ms. These are Node measurements; no stable MB heap saving is claimed.
- Fifth-1's **22/22 workerd smoke checks were on an earlier SHA (`2b06f5b`)**, not current optimized HEAD. Current-HEAD workerd has not been re-run. No real Cloudflare deployment, real browser/Tampermonkey session, or live-game test has happened.
- Room alarm interval is **300,000 ms / 5 minutes**, about **288 alarms per active room per day**, not the earlier 60-second / 1,440 figure. Cost math is in `docs/cost-estimate.md`.
- `src/gats-community/INSTRUCTIONS.md` was checked/fixed at `4d455584` for registration cap, 300-second alarm, deploy-replaces-existing-worker warning, Node 20.6+ / npm test info, and presence troubleshooting. #26's work is recorded in the archived issue.

### Important residual security findings — do not mark complete
1. `gate.js` uses persisted counters, IPv6 /64 normalization, failure-only accounting, per-IP/per-account limits, per-IP register/rename limits and `MAX_REG_PER_DAY=300`. Failed password attempts write zero D1 rows; random unknown usernames do not create account Gates. However:
   - Critic's round-3 **check-then-fail TOCTOU** model allowed 200 concurrent guesses past a limit of 10. This is a model reproduction, not yet a real-DO reproduction.
   - Quota simulation confirmed **account lockout griefing**: after 2,000 failures from one IP, the account owner logging in from a different IP was rate-limited for 15 minutes.
   - Gate is documented as fail-open if its storage/quota path fails. See `docs/review-claude-sonnet-round3.md` and `docs/test-report-researcher-1.md`.
2. **Reserved-name normalization still needs verification/fix.** Current worker helper checks exact lowercase membership in the reserved set; usernames permit dots, underscores, hyphens. Critic reported variants like `admin.` and `ad-min` could bypass exact matching. An attempted normalizing patch was withdrawn; do not treat this item as resolved merely because the set/cooldown exists.
3. The 5-minute alarm reduces budget use but ban/revocation enforcement from an unnamed room can lag by up to a sweep; current-HEAD workerd hibernation/revocation timing still needs a run.
4. Presence name matching (`gname` must equal the game's d-frame username) is only a spoofing mitigation, not cryptographic identity.

### User-dependent deployment / missing artifacts
Before any production claim: user must confirm real game WebSocket hostnames (currently `ALLOWED_ROOM_SUFFIX="gats.io"` is a guess), fill the D1 `database_id`, set Worker secrets `TOKEN_SECRET`, `PEPPER`, `ADMIN_KEY`, back up the deployed old KV Worker because `wrangler deploy` replaces the existing `login-info-handler`, and apply `src/gats-community/schema_002.sql` once after the base schema. User should rotate the relay GitHub tokens previously exposed in the original relay instructions; do not copy them into repository/docs/issues.

Legacy sources actually present: `docs/legacy/index.js` + README (old KV Worker), `docs/reference/gats-protocol-reference.md`, `docs/reference/userscript-skeleton.user.js`, `docs/gats-protocol.md`, `docs/skeleton.user.js`, `docs/design-doc.md`, and `docs/legacy-v1.8-digest.md`. The older GitGamedev project restarted after the DDoS and the complete v1.8 userscript are **not** present in this repo; the digest is not the full script. Ask the user to re-upload/link those files if still required. Never invent lessons from missing content.

### Issue reset completed
All previously open issues #1, #4, #5, #8, #9, #10, #12, #17, #19, #20, #21, #22, #23, #25 were closed with reason `duplicate` as administrative supersessions and a comment pointing to their replacements. The replacement issues are open and contain the unchanged original description plus a compressed work record:
- #27 replaces Mission #1 — mission plus global status and remaining real-run requirements.
- #28 replaces security review #4.
- #29 replaces userscript review #5.
- #30 replaces hibernation/revalidation bug #8.
- #31 replaces Gate/throttle issue #9 (TOCTOU + lockout grief remain).
- #32 replaces rename/signup/reserved-name issue #10 (normalization bypass remains suspect).
- #33 replaces phantom-player issue #12.
- #34 replaces memory-optimization issue #17.
- #35 replaces missing-files chat #19.
- #36 replaces legacy-project request #20.
- #37 replaces tester pass #21.
- #38 replaces memory-optimization duplicate #22.
- #39 replaces tester-pass duplicate #23.
- #40 replaces cleanup claim/help log #25.
Use #27 as the mission tracker and #40 for one-line CLAIM/DONE/RELEASE/HELP/JOINING status. The paired duplicates (#34/#38 and #37/#39) are preserved because this reset deliberately made one replacement per old open issue; avoid duplicating actual work.

### Issue deletion limitation
This GitHub connection exposes issue creation, comments, and close/update operations but no permanent issue-delete operation; GitHub issues cannot be individually deleted through the supported issue API. Therefore **closed issues have not been and cannot be permanently deleted from this integration**. They remain as archived history. Do not claim otherwise.


## ADDENDUM — duplicate consolidation correction (2026-10-25 04:18 UTC)

After the one-for-one reset, exact duplicate open workstreams were consolidated to keep the active queue smaller. The earlier reset list above remains an audit trail; the **current active queue** is:
- #27 mission / real-run gates
- #28 security review
- #29 userscript protocol review
- #30 hibernation/revalidation test on current HEAD
- #31 Gate/lockout TOCTOU and griefing
- #32 reserved-name normalization risk (plus completed cooldown/signup-cap work)
- #33 userscript phantom-player review/test
- #34 memory optimization + current-HEAD runtime verification (also contains the prior #22 description)
- #35 missing legacy artifacts (also contains prior #20 description)
- #37 combined tester pass (also contains prior #23 description)
- #40 cleanup claim/help log

New issue #36 was closed as duplicate of #35; #38 as duplicate of #34; #39 as duplicate of #37. The canonical issue bodies contain both original descriptions, so task scope/evidence has not been discarded. This is the current state after consolidation; use only the active IDs above for new comments/work. No source code was touched.
