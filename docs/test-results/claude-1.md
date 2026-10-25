# claude-1 test results (scenarios G and I)
SHA tested: c7a1544

| id | scenario | how run | result | notes |
|---|---|---|---|---|
| G1 | b/c frames for unknown ids create no ghost / no injection | node replay harness, scratch/claude-1/replay.mjs (hook_handler extracted from the userscript, stubbed GCL) | PASS | |
| G2 | claim with matching gname swaps name, injects d+c | same | PASS | |
| G3 | gname mismatch rejected | same | PASS | not cryptographic identity (see #11) |
| G4 | blank-field (delta) c frame keeps radius/colour | same | PASS | |
| G5 | rename rebuild replays old chat bubble | same | FAIL then fixed | #26 fixed in 329c2e5; PASS at c7a1544 |
| G6 | own a-frame fields 18 and 23 get community name; hello sends ORIGINAL in-game name | same | PASS | |
| G7 | lookup throttle per ghost | same | PASS | |
| G8 | e-frame then pid reuse with new name not mislabelled | same | PASS | |
| G9 | logout clears GM session and fires logout event | code reading only (performLogout) | NOT RUN | not executed in a browser/Tampermonkey |
| G10 | presence socket never tapped by our hook | code reading only (NativeWebSocket captured before hook) | NOT RUN | needs a browser |
| I1 | npm test at HEAD | npm test in src/gats-community, Node 22 | PASS | 27/27 |
| I2 | documented gate test command | node --test tests/gate.test.mjs | PASS | 5/5 |
| I3 | INSTRUCTIONS.md vs code: wrangler.toml vars, /health, routes, schema_002 | grep + reading | PARTIAL | 5 stale/missing statements, see below |
| I4 | deploy steps (wrangler login/d1/secrets/deploy) | NOT RUN: no Cloudflare account in this sandbox | NOT RUN | |

## INSTRUCTIONS.md findings (not edited: TEST-PASS says do not touch src/)
1. Stale: "A configurable daily registration cap is not yet implemented" in the caveats. Code has MAX_REG_PER_DAY (worker.js, wrangler.toml default 300) and the Gate section documents it.
2. Stale: "At a 60-second alarm interval ... 1,440 alarms". ALARM_MS is 300000 now (about 288/day/room); the last paragraph already says 5 minutes.
3. Stale: "while #7/#9/#10 remain under review" (issue numbers mean nothing to a user; say what is still unverified instead).
4. Missing: first line of deploy should warn that wrangler deploy replaces the existing login-info-handler worker, including dashboard-edited code and its old AUTH_KV binding (bindings come from wrangler.toml). Back up the old worker first; the old KV namespace can be deleted afterwards.
5. Missing: Node version needed to run tests (uses --import, so Node 20.6+), and that npm test runs all 27 while the doc mentions only the 5 gate tests.
6. Not checkable here: the checklist item "confirm a token is stored in Tampermonkey" (needs a browser).
