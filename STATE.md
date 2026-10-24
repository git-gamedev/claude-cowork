# STATE

## Checkpoint and pause
A relay pause occurred while collaborators were unavailable due to token/context limits. The original four agents and a fifth collaborator with independent work are expected back at 10:30 PM local on 2026-10-24. Context is compressed in [docs/RELAY-HANDOFF.md](docs/RELAY-HANDOFF.md). The handoff is a checkpoint, not a claim that the implementation is complete.

## Goal
Free-tier secure login + presence for gats.io (docs/MISSION.md, issue #1). Deliver a Tampermonkey userscript, Cloudflare Worker, Durable Object, D1 schema convention, and detailed setup instructions.

## Canonical architecture decision
Canonical base: `src/gats-community`. `src/gats-login` and `src/gcl-worker` are donor/reference trees only. Prefer client-side PBKDF2 to keep the password off-server and avoid relying on an unverified DO CPU-limit exemption. Build page-facing `MessageEvent`/`Uint8Array` in the game/page realm via `unsafeWindow`. Preserve token-in-WebSocket-subprotocol, HMAC verification, attachment-based WebSocket hibernation state, rename revocation checks inside SQL UPDATE, and runtime ping/pong auto-response.

## Recent implementation commits (re-review needed)
- `28b5e88`: Room now revalidates active sockets on every alarm, removing the in-memory timestamp that reset after hibernation. This addresses #8's logic flaw, but per-room alarm/D1 read cost must still be assessed.
- `2452750`: Userscript ignores b/c status/movement frames for unknown IDs; only d-frames create ghost records. This addresses the phantom-player bug in #12.
- `95c5711` + `8d54fab`: Presence hello/roster/join/lookup/rename carry the game's in-game name (`gname`). Client applies a community name only when `gname` exactly matches the real d-frame username; own a-frame field 23 is updated too. This mitigates #11 but is not cryptographic identity proof.
These files were syntax-parsed in the connector before commit. No live-game or Cloudflare integration tests have been run; keep the issues open until review and appropriate tests.

## Open issues / remaining work
- #4 / #5: Critic's review is in docs/review-claude-sonnet.md; re-review the recent changes and future fixes.
- #6: Tests were paused pending base choice. Base is now chosen; add local tests against `src/gats-community` (tokens, KDF/HMAC, login/register, Room hello/lookup/rename/kick/revalidation and ghost/presence-name behavior).
- #7: Failed passwords must not write D1 per attempt. Current base still needs durable, low-cost throttling/lockout that resists per-instance eviction and avoids easy victim lockout.
- #9: Current Gate remains per-IP/in-memory; evictable, shared-IP-unfriendly, IPv6-rotatable, success-counting, and no per-account defense. Design a bounded/global approach, count failures rather than successful logins, normalize IPv6 /64, and document limitations.
- #10: Add 24h rename cooldown (`renamed_at` migration required), reserved-name checks, room suffix allowlist, and consider a configurable registration cap/Turnstile.
- #11: Keep the gname matching mitigation and explicitly document residual risk: players can still claim an in-game name; without game-server cooperation this is not authenticated identity.
- #12: Core b/c ghost creation has been fixed, with a-frame field 23 updated; re-review/test before closing.
- #3 remains an open duplicate according to the last handoff. #1 is the Mission and remains open.

## Next
1. Confirm whether new commits arrived after this checkpoint.
2. Critic re-reviews commits above; implement remaining #7/#9/#10 ports in `src/gats-community`, small commits, with tasks claimed before work.
3. Add local tests and review free-tier cost of alarm revalidation (about 1,440 DO alarms/active room/day at a 60-second interval, plus batched D1 reads).
4. Merge useful donor features without replacing the canonical tree; refresh detailed instructions and schema migration docs.
5. Post DONE and close Mission #1 only when deliverables are genuinely complete.

## Incoming independent collaborator and legacy project
The fifth collaborator has separate research/work. Ask them to share findings, artifacts, and links before duplicate work. They also received the older GitGamedev project that the user restarted after a DDoS exposed a flawed structure. Its repository/path is not identified in this relay repo yet; ask them to link or provide that project and relevant architecture notes so the team can compare lessons.
