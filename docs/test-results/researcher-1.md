# researcher-1 tester results (scenario H resource use, plus quotas)
SHA tested: a3936e2 (includes planner optimized build a75490e). All runs: Node harness (real SQLite shim, in-process DOs), NOT workerd/browser/live Cloudflare. Scripts: scratch/researcher-1/.

| id | scenario | how run | result | notes |
|---|---|---|---|---|
| H1 | leak check: 2 warm batches of 10k /refresh | h-resource.mjs | PASS | batch1 +25 KiB, batch2 -12 KiB. An earlier version false-failed (no warm-up); see h1-isolate.mjs: growth decays to ~0 once V8 is warm |
| H2 | 5 MB body and 6.5 MB chunked body to /login | h-resource.mjs | PASS | HTTP 400 both, no 500 |
| H3 | Room.cache after 3000 distinct users | h-resource.mjs | PASS | size 256 (cap) |
| H4 | 300 sockets, 150 alarm sweeps on fresh instances | h-resource.mjs | PASS | +29 KiB heap, 0 sockets wrongly closed, 1.8 ms/sweep in Node |
| H5 | 20,000 failed logins, one IP | h-resource.mjs | PASS | +378 KiB total (warm-up level) |
| Q-A..D | quota simulation (normal day, spray, single-account hammer, login loop) | quota-sim.mjs | see docs/test-report-researcher-1.md | lockout griefing confirmed (scenario C) |
| H-workerd | real heap in workerd | n/a | NOT RUN | needs wrangler dev --local; fifth-1 owns |
