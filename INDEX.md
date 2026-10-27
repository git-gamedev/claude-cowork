# INDEX
(Created by researcher-2 because no planner was active; planner may take over. What + where only.)

## Canonical (the only tree that matters)
- src/gats-community/
  - gats-community.user.js   Tampermonkey client (auth UI, ws hook, presence client, frame handler)
  - src/worker.js            Worker entry: routes, tokens, reserved-name check, rate-limit calls
  - src/gate.js              Gate Durable Object: persisted fixed-window failure counters
  - src/room.js              Room Durable Object: presence, hibernating sockets, 5-min revalidation alarm
  - schema.sql, schema_002.sql   D1 tables; 002 adds users.renamed_at (apply base, then 002)
  - wrangler.toml            bindings and vars (ALLOWED_ROOM_SUFFIX is a guess; database_id placeholder)
  - INSTRUCTIONS.md          user-facing deploy and smoke-test guide
  - tests/                   Node harness; `cd src/gats-community && npm test`

## Donor / historical (do not edit or deploy)
- src/gats-login/, src/gcl-worker/

## Process docs (read only the one you need)
- STATE.md                   current goal + status
- docs/HANDOFF-MORNING.md    main handoff: file map, decisions, relay traps (+ addendum with newest facts)
- docs/RELAY-HANDOFF.md      earlier checkpoint
- docs/MISSION.md            mission text from the user
- docs/CLEANUP.md            claim/done protocol (log in issue #40)
- docs/TEST-PASS.md          tester-pass plan and result format

## Reviews, cost, design
- docs/review-claude-sonnet*.md        security reviews (round 1-3)
- docs/optimization-sonnet-1.md        memory optimization report
- docs/cost-estimate.md, docs/review-researcher-cost.md, docs/research-free-tier.md
- docs/design-doc.md, docs/compare-implementations.md, docs/protocol-notes.md
- docs/test-report-researcher-1.md     quota estimates

## Test results
- docs/test-results/<agent>.md         one file per tester (claude-1/2/3, researcher-1/2, sonnet)
- docs/test-results/researcher-1-workerd.md   workerd run at an earlier HEAD

## Game protocol and legacy
- docs/gats-protocol.md, docs/reference/    wire protocol and original skeleton, verbatim from the user
- docs/legacy/, docs/legacy-v1.8-digest.md  old KV worker and old userscript, lessons

## Scratch (per-agent, throwaway but reproducible)
- scratch/<agent>/    claude-1 replay.mjs (userscript frame replay), fifth-1 workerd smoke tests,
                      researcher-2 gate-realrun.mjs + smoke-canonical-v2.mjs, others: repros and benches
