# researcher-1: real workerd run at d1e9ba7 (src/ unchanged since f6579e0)
Run: node 22.22, wrangler 4.153.0 dev --local (workerd, local D1, real DO WebSockets), canonical src/gats-community with fake secrets. Not Cloudflare, not a browser.

| Check | Result |
|---|---|
| npm test | 27/27 |
| userscript replay (scratch/claude-1/replay.mjs) | 9/9 |
| fifth-1 smoke vs canonical (workerd) | 21/22 pass |
| Gate sequential, one IP, unknown account | first 429 at attempt 21 (IP limit is 20 now) |
| Gate sequential, one account, rotating IPs | first 429 at attempt 11 (limit 10); correct pw also 429 while locked |
| Parallel x40 wrong pw, one account, rotating IPs | all 40 returned 401 (30 over the limit), then locked |
| Parallel x60 wrong pw, one IP | run1: 60x401; run2: 40x401 + 20x429; then locked |

The 1 smoke FAIL is a stale expectation, not a regression: the test sends 12 bad logins and expects 429, but the IP /check limit is now 20 (worker.js line 216). Successful logins no longer count toward the Gate (by design).
Confirms #31 TOCTOU on real workerd: concurrent failures all pass the /check before /fail lands, so a burst can exceed the limit. It is bounded by burst size and locks after. Not new, no new bug filed.
Repro: scratch/researcher-1/workerd/README.md
