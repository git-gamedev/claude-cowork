# STATE

## Checkpoint — 2026-10-24
A relay pause occurred while collaborators were unavailable due to token/context limits. The work has now been compressed into **docs/RELAY-HANDOFF.md** (checkpoint commit: 7fde9558a7d3373d3e53fead5231de443ef43bfe). Read that handoff before re-reading the full Mission #1 thread. This is a handoff/compression step, not a claim that implementation is complete. User expects the original four agents and a fifth independent-work collaborator back at 10:30 PM local time tonight.

## Goal
Free-tier secure login + presence for gats.io (docs/MISSION.md, issue #1). Deliver a Tampermonkey userscript, Cloudflare Worker, Durable Object, D1 schema convention, and setup instructions.

## Canonical architecture decision
Canonical base: `src/gats-community` (latest base decision commit at checkpoint: `81cd9c5`). `src/gats-login` and `src/gcl-worker` are donor/reference trees only. Prefer client-side PBKDF2 to keep the password off the server and avoid relying on an unverified DO CPU-limit exemption. Build `MessageEvent`/`Uint8Array` in the page realm via `unsafeWindow`. Preserve token-in-WebSocket-subprotocol, HMAC verification, attachment-based WebSocket hibernation state, and rename revocation checks inside SQL UPDATE.

## Open issues / implementation status
- #4 / #5: critic review notes recorded in docs/review-claude-sonnet.md; re-review after fixes.
- #6: local tests were paused pending base choice; base now chosen, so resume tests against `src/gats-community`.
- #7: avoid D1 write for every failed password attempt; use bounded failure counters and persist a lock record only when threshold trips.
- #8: alarm revalidation is currently broken by constructor-reset timestamp after hibernation. Revalidate each alarm or persist timestamp; estimate alarm/D1 cost carefully.
- #9: current per-IP in-memory Gate is evictable, shared-IP-unfriendly, IPv6-bypassable, and lacks per-account throttling. Normalize IPv6 /64, count failures not successes, bound state, and document best-effort limits.
- #10: add 24h rename cooldown, reserved names, room allowlist, and consider configurable registration cap/Turnstile.
- #11: presence pid claims cannot be cryptographically authenticated without game-server cooperation; port gname matching mitigation and document residual cosmetic/spoofing risk.
- #12: b/c frames must not create ghosts; only d frames create player records. Review a-frame field 23 and stale pid/name cache handling.
- #3 remains an open duplicate according to the last handoff. #1 is the mission and remains open.

## Next
1. Confirm whether new commits arrived after checkpoint.
2. Implement fixes and donor ports in `src/gats-community`, small commits, claim each issue before working.
3. Critic re-reviews; implement local tests; researcher re-checks free-tier costs as needed.
4. Refresh this file and setup instructions after progress; post DONE and close #1 only after deliverables are genuinely complete.

## Incoming collaborator
The user says a fifth collaborator has independent work/research and was also given the older GitGamedev project that was restarted after a DDoS exposed a flawed structure. Ask them to share their research and link/provide the legacy project/artifacts so the team can compare lessons. Its repo/path is not identified in this relay repository yet.


