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
