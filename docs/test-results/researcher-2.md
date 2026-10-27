# researcher-2 tester results (scenarios F, B slice, reserved names; real workerd)
SHA tested: f6579e0 (src/gats-community unchanged through 9cc3ca0). Runtime: wrangler 4.153 `dev --local` (workerd, local D1, real DOs), Node 22. Scripts: scratch/researcher-2/. Not run: deployed Cloudflare, browser/Tampermonkey, live game.

| id | scenario | how run | result | notes |
|---|---|---|---|---|
| S0 | `npm test` | node | PASS | 27/27 |
| S0b | userscript replay | scratch/claude-1/replay.mjs | PASS | 9/9 |
| S1 | fifth-1 22-check smoke vs current worker | scratch/fifth-1/tests/smoke-canonical-gats-community.mjs | 21/22 | The one FAIL ("gate rate limits after 10 hits", got 401) is a STALE EXPECTATION, not a worker bug: HEAD counts failures only (20 per IP /64, 10 per existing account, gate.js + worker.js:213-227); the test sends 12 failures. Test needs updating. Same result as claude-3 and researcher-1. |
| F1 | 15 successful logins, one IP | gate-realrun.mjs | PASS | 15x200 (successes not throttled, fix for #9) |
| F2 | 25 sequential failures, unknown login, one IP | same | PASS | 20x401 then 429 from attempt 21 |
| F3 | 12 wrong pw on one account from 12 IPs, then correct pw | same | PASS | 429 from attempt 11. Correct pw afterwards also 429: lockout griefing (known accepted limit) |
| F4 | 60 parallel wrong-pw, one account, one IP | same | FAIL | 53x401, 7x429 vs limit 10 (excess 43). TOCTOU confirmed, tracked in #31 |
| F5 | 60 parallel failures, unknown login, one IP | same | FAIL | 60x401, 0x429 vs limit 20 (excess 40). All /check calls run before any /fail lands. #31 |
| F6 | 25 failures from 25 addresses in one IPv6 /64 | same | PASS | 429 from attempt 21: /64 grouping works on workerd |
| F7 | 7 registrations, one IP | same | PASS | 200 x5 then 429 x2 |
| B1 | unknown user vs wrong pw | same | PASS | both 401 {"error":"invalid_credentials"}. Timing parity NOT RUN |
| R1 | reserved-name look-alikes through real /register + real D1 | same | FAIL | 409: admin, Admin, gats.io. 200 (registered): admin. admin_ admin- ad.min gats-io gats_io mod. system. Confirms #32 bypass end to end (earlier repros were helper-only). |

Notes: wrangler logs one harmless `ENOTFOUND workers.cloudflare.com` (sandbox, version check). No worker exceptions in dev.log. No src/ edits; no new issues opened (findings already tracked in #31, #32).
