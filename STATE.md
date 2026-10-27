# STATE (rewritten by claude-1, night 1 end, 2026-10-25)

**Start with [docs/HANDOFF-MORNING.md](docs/HANDOFF-MORNING.md).** It has the file map, decisions, what is verified, what is not, relay rules and first moves. This file is only the index.

## Goal
Free-tier secure login + presence for gats.io: Tampermonkey userscript, Cloudflare Worker, Durable Objects, D1 schema, setup instructions (docs/MISSION.md, issue #1).

## Canonical code
`src/gats-community/` only. `src/gats-login` and `src/gcl-worker` are donor trees. Run `npm test` there (27 tests) and `node scratch/claude-1/replay.mjs` (9 checks).

## Status at the end of night 1
- Implemented and locally tested: register/login/refresh/rename/ban, Gate throttling, Room presence with hibernation and revalidation, userscript frame hooking, allocation/CPU optimizations, cost model.
- NOT done: any real run (Cloudflare deploy, workerd, browser/Tampermonkey, live game). The user still has to confirm real game hostnames (ALLOWED_ROOM_SUFFIX is a guess), apply schema_002.sql, fill database_id, set secrets TOKEN_SECRET/PEPPER/ADMIN_KEY, and rotate the GitHub tokens used by this relay.
- Mission #1 stays open until the real-run items in the handoff section 5 pass.

## Where things are
- Reviews: docs/review-*.md. Cost: docs/cost-estimate.md, docs/review-researcher-cost.md. Optimization: docs/optimization-sonnet-1.md. Tests: docs/TEST-PASS.md (plan), docs/test-results/*.md (results), docs/test-report-researcher-1.md.
- Protocol and legacy: docs/gats-protocol.md, docs/reference/, docs/legacy/, docs/legacy-v1.8-digest.md.
- Process: docs/CLEANUP.md and issue #25 (claim/done log).


---

## Current relay reset addendum (2026-10-25 04:15 UTC)
After the next Claude round, the source checkpoint is `4d455584f7a792ae6956feef4944731eb023fb59`. See the appended current-truth section in `docs/HANDOFF-MORNING.md`; the earlier checkpoint `docs/RELAY-HANDOFF.md` has also received an additive correction, not a rewrite.

Evidence currently recorded: `npm test` 27/27; userscript recorded-frame replay 9/9; resource benchmarks are Node-only. Workerd 22/22 was an earlier SHA only; current HEAD, deployed Cloudflare, browser/Tampermonkey, and live game remain untested.

Critical remaining findings: Gate check-then-fail TOCTOU and account lockout griefing; reserved-name punctuation bypass is still suspected because the current helper checks exact lowercased names. Alarm interval is 300 s (~288 alarms/active room/day). Actual game hostnames and deployment setup remain user-dependent.

Issue reset mapping: #1→#27, #4→#28, #5→#29, #8→#30, #9→#31, #10→#32, #12→#33, #17→#34, #19→#35, #20→#36, #21→#37, #22→#38, #23→#39, #25→#40. Old issues were closed as superseded; GitHub individual issue deletion is unavailable via this connection, so closed history remains. New mission is #27; cleanup log is #40.


## Active issue correction after duplicate consolidation (2026-10-25 04:18 UTC)
The first reset opened #27–#40 one-for-one. Duplicate consolidation then closed #36 → #35, #38 → #34, and #39 → #37 after copying the old descriptions into the canonical issue bodies. Current active issues: #27, #28, #29, #30, #31, #32, #33, #34, #35, #37, #40. No source/code edits were made in this pass.

## 2026-10-27 update (researcher-2, no planner active; supersedes "Critical remaining findings" above)
At 037a277 #31 (Gate TOCTOU) and #32 (reserved names, caps, cooldown) are fixed and verified on real workerd: docs/test-results/researcher-2.md. npm test 35/35, smoke v2 23/23, INDEX.md added.
Still needs the user: real Cloudflare deploy, real game hostnames, browser/Tampermonkey run.
