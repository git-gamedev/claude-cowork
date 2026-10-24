# Relay handoff — 2026-10-24 checkpoint

This file compresses the relay discussion and research so the team can resume after a pause. It is a checkpoint, not a claim that implementation or testing is complete.

## Pause and resume

The relay paused while collaborators were out of available context/tokens. The user expects the group to return at **10:30 PM local time tonight**. This checkpoint consolidates the decisions, known findings, and next actions from the repository so work can resume without rereading the full discussion.

Current default branch head at checkpoint: `81cd9c5530ca1b0d6a903b1f0f9bd6b4892ee126` (`planner: base-tree decision`). The source tree still contains the reviewed defects described below; no implementation fix commits or tests are visible in the recorded main-branch history. Reviews and research are useful, but they are not verification on Cloudflare or against the live game.

## Mission

Deliver a free-tier login and presence system for gats.io: Tampermonkey userscript, Cloudflare Worker, Durable Object, D1 schema convention, and deploy/setup instructions. The existing Worker is named `login-info-handler`. The client keeps its signed token in `GM_setValue`, calls auth endpoints with an Authorization header, and uses one WebSocket for presence/lookups. D1 should remain durable storage, not hot-path room state.

## Canonical architecture decision

**Use `src/gats-community/` as the only canonical tree.** Treat `src/gats-login/` and `src/gcl-worker/` as donor/reference implementations, not alternate bases.

Reasons:
- Client-side PBKDF2 keeps the password off the server and avoids relying on the unverified claim that Durable Objects are exempt from the Workers free-plan CPU limit.
- Build the page-facing `MessageEvent` / `Uint8Array` in the game/page realm via `unsafeWindow`; user-script sandbox objects can fail the game's `instanceof ArrayBuffer` checks.
- Preserve token-in-WebSocket-subprotocol, HMAC verification, attachment-based WebSocket state for hibernation, constant-time `subtle.verify`, rename revocation checks inside the SQL UPDATE, and runtime ping/pong auto-response.

Useful donors from `src/gats-login/`: per-user salt/prelogin, `/unregister`, logout-everywhere, 24-hour rename cooldown, reserved-name checks, a room suffix allowlist, stronger pid/name matching, and uid-to-last-room/cache ideas for revocation. Do not copy its per-failed-login D1 writes as-is. `src/gcl-worker/` uses server-side PBKDF2 and should not be the base; the exemption-from-CPU-cap premise was explicitly withdrawn as unverified.

## Findings and required fixes

- **#7 — failed-login writes / lockout griefing (high):** `src/gats-login` updates D1 on every wrong password, allowing quota exhaustion and victim lockout. Avoid per-attempt D1 writes. The discussion proposes in-memory counters per username and per IP (normalize IPv6 to /64), persisting a lock record in DO storage only when a threshold is crossed. Prefer pair-level lockout first and a higher threshold before account-wide lockout to reduce griefing.
- **#8 — revocation revalidation never runs after hibernation (high):** `Room` sets `lastReval = Date.now()` in the constructor, but hibernation creates a new instance between 60-second alarms; therefore the 300-second condition never trips. Revalidate on each alarm or persist the timestamp. Researcher recommends every alarm while sockets exist, with alarms rescheduled only when sockets exist (already the current pattern). Cost caveat: 60-second alarms are about 1,440 DO requests per active room per day plus batched D1 reads; assess room count and free-tier limits carefully before treating this as cost-free.
- **#9 — throttle is weak and can itself be costly:** current `Gate` is one DO per IP with in-memory state; eviction resets the window, shared IPs interfere, IPv6 rotation bypasses it, successes consume quota, and there is no per-account limit. Prefer a bounded/global throttle DO map where appropriate, failure-only counting, IPv6 /64 normalization, per-account protection, expiry/eviction, and storage writes only when a lock trips. Explicitly document any best-effort limitation.
- **#10 — rename/registration abuse:** add a `renamed_at` guard (suggested 24-hour cooldown), reserve staff/system names, enforce the room allowlist, and consider a configurable global registration cap (or Turnstile). Without controls, name churn and registrations can consume shared D1 write quota and reserved-name gaps permit staff impersonation.
- **#11 — presence claims cannot be cryptographically authenticated by the game server:** current room hello trusts a pid; first-claim-wins only prevents duplicate claims inside the room. Port the practical mitigation from `gats-login`: send the in-game name (`gname`, a-frame field 18) in hello/roster/join and apply a community name only if it matches the local d-frame username. Retain a clear note that this is a mitigation, not cryptographic identity proof.
- **#12 — phantom players from b/c frames:** b/c frames create ghost records for ids with no d-frame, including after an e-frame; name rebuild can inject a blank d-frame. Only d-frames should create ghosts; in b/c handlers, ignore ids that do not already exist. Also review a-frame field 23 (`isolatedUsername`) and stale `LAZY_IDS` / pid caches.

## Work already recorded

- `docs/review-claude-sonnet.md`: critic's code review and findings, including protocol, throttle, alarm, room-name, userscript, and revocation observations.
- `docs/compare-implementations.md`: quick donor map for choosing the stronger implementation pieces.
- `docs/research-free-tier.md`: researcher's free-tier notes. Both variants use SQLite-backed DOs; client-side KDF is preferred; over-quota operations can fail until reset; alarms are billed requests; ping/pong auto-response avoids waking the DO.
- Issue #4 and #5 review notes were posted; they were waiting for implementer acknowledgement/re-review rather than representing fixed code.
- #6 tests were intentionally paused until a canonical base was chosen. The base decision is now made, so tests should resume against `src/gats-community/`.
- #2 was marked a duplicate; #3 remains an open duplicate according to the latest handoff.
- #7–#12 are open tracking issues. Do not close them until the corresponding code change is reviewed and the outcome documented. Do not reopen closed issues.

## Next sequence

1. Pull/read current `STATE.md` and main; confirm no new commits arrived since this checkpoint.
2. Implement the decision's ports/fixes in `src/gats-community/`, one small change/commit at a time. Claim each issue before working and do not edit unrelated files.
3. Re-review each implementation change, especially the userscript protocol changes and security/cost tradeoffs.
4. Add local tests for tokens, KDF/HMAC, registration/login, and Room hello/lookup/rename/kick/expiry/revalidation. Tests have not been run against the live game or Cloudflare.
5. Revisit the setup instructions and clearly document free-tier/cost caveats and the residual, non-cryptographic nature of presence claims.
6. Once reviewed and tested as far as possible, refresh `STATE.md`, post a concise `DONE` status on Mission #1, and close the mission only when the deliverables are genuinely complete.

## Incoming independent collaborator and legacy project

The user says an additional collaborator is joining with separate work/research done off to the side. Ask them to share their findings and any artifacts/links with the team before duplicate work begins. The user also says they previously shared with that collaborator an older GitGamedev project that was restarted after a DDoS exposed weaknesses in its structure. That legacy project is not identified by a path or URL in this relay repo; ask the collaborator to link it or bring the relevant files/architecture notes into the relay so the team can compare lessons without assuming its details.
