# STATE

## Checkpoint and pause
A relay pause occurred while collaborators were unavailable due to token/context limits. The original four agents and a fifth collaborator with independent work were expected back at 10:30 PM local on 2026-10-24. Context is compressed in [docs/RELAY-HANDOFF.md](docs/RELAY-HANDOFF.md). The handoff is a checkpoint, not a claim that implementation is complete. A pause/compression announcement and request for the incoming collaborator's research + legacy project link/files is posted on Mission #1.

## Goal
Free-tier secure login + presence for gats.io (docs/MISSION.md, issue #1). Deliver a Tampermonkey userscript, Cloudflare Worker, Durable Object, D1 schema convention, and detailed setup instructions.

## Canonical architecture decision
Canonical base: `src/gats-community`. `src/gats-login` and `src/gcl-worker` are donor/reference trees only. Prefer client-side PBKDF2 to keep the password off-server and avoid relying on an unverified DO CPU-limit exemption. Build page-facing `MessageEvent`/`Uint8Array` in the game/page realm via `unsafeWindow`. Preserve token-in-WebSocket-subprotocol, HMAC verification, attachment-based WebSocket hibernation state, rename revocation checks inside SQL UPDATE, and runtime ping/pong auto-response.

## Recent implementation commits (re-review required)
- `28b5e88`: Room revalidates active sockets on every alarm, removing the in-memory timestamp that reset after hibernation. Addresses #8's logic flaw; per-room alarm/D1 read cost still needs assessment.
- `2452750`: Userscript ignores b/c frames for unknown IDs; only d-frames create ghost records. Addresses the core phantom-player logic in #12.
- `95c5711` + `8d54fab`: Presence hello/roster/join/lookup/rename carries the in-game name (`gname`). Client applies a community name only when `gname` matches the real d-frame username; own a-frame field 23 is updated too. Mitigates #11 but is not cryptographic identity proof.
- `c730e86`: Worker adds a 24-hour rename guard, reserved-name checks, and a domain-suffix room allowlist.
- `80b9035`: Adds additive migration `src/gats-community/schema_002.sql` for `users.renamed_at`. Apply once after the base schema to any target D1 DB before deploying the cooldown change.
- `76c68ed`: Sets `ALLOWED_ROOM_SUFFIX = "gats.io"` in `wrangler.toml`; verify actual game WebSocket hosts before relying on this default.
- `a1e120b`: Adds canonical setup guide `src/gats-community/INSTRUCTIONS.md`; it distinguishes canonical routes from donor-only endpoints and notes outstanding limitations.

Worker and userscript source changes were syntax-parsed in the relay workflow, but **no live-game or Cloudflare integration tests have been run**. Keep issues open until independent review and appropriate tests. These fixes are not a claim of production readiness.

## Open issues / remaining work
- #4 / #5: Critic's review is in `docs/review-claude-sonnet.md`; re-review the recent changes and future fixes.
- #6: Tests were paused pending base choice. Base is now chosen; add local tests against `src/gats-community` (tokens, KDF/HMAC, login/register, Room hello/lookup/rename/kick/revalidation and ghost/presence-name behavior).
- #7: Failed passwords must not write D1 per attempt. Current base still needs a durable, low-cost throttling/lockout approach that resists instance eviction and avoids easy victim lockout.
- #9: Current Gate remains per-IP/in-memory; it is evictable, shared-IP-unfriendly, IPv6-rotatable, success-counting, and has no per-account defense. Design a bounded/global approach, count failures rather than successful logins, normalize IPv6 /64, and document limitations.
- #10: Cooldown/reserved names/room allowlist are implemented but need critic review and tests. A configurable registration cap is not implemented yet; keep open.
- #11: Keep the gname matching mitigation and explicitly document residual risk: clients can still claim an in-game name; without game-server cooperation this is not authenticated identity.
- #12: Core b/c ghost creation is fixed and a-frame field 23 updated; critic re-review/tests required.
- #3 remains an open duplicate according to last handoff. #1 is the Mission and remains open.

## Next
1. Confirm whether new commits arrived after this checkpoint.
2. Critic re-reviews commits above; implement remaining #7/#9 work in `src/gats-community`, small commits, with tasks claimed before work.
3. Add local tests and assess free-tier cost of alarm revalidation (~1,440 alarms per active room per day at 60 seconds, plus batched D1 reads).
4. Verify the actual game-server hostname against `ALLOWED_ROOM_SUFFIX`; apply `schema_002.sql` once before deploying cooldown code to an existing D1 database.
5. Merge useful donor features without replacing the canonical tree; refresh instructions and schema migration docs as needed.
6. Post DONE and close Mission #1 only when deliverables are genuinely complete.

## Incoming independent collaborator and legacy project
The fifth collaborator has separate research/work. Ask them to share findings, artifacts, and links before duplicate work. They also received the older GitGamedev project that the user restarted after a DDoS exposed a flawed structure. Its repository/path is not identified in this relay repo yet; ask them to link or provide that project and relevant architecture notes so the team can compare lessons.

## sonnet-1 update (takeover)
- Gate rewritten in src/gats-community/src/gate.js: persisted counters (survive eviction), failures-only login limits (IP /64 + per account), register/rename limits, global daily signup cap MAX_REG_PER_DAY. Fixes #9, covers the remaining #10 item; #7 premise does not apply to this base (no D1 writes on failed login).
- Tests: src/gats-community/tests/gate.test.mjs (5 passing). Still missing: tests for tokens/KDF and Room (part of #6).
- Still unverified: real gats server hostnames vs ALLOWED_ROOM_SUFFIX; no Cloudflare/live-game run.
