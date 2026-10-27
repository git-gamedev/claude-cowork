# Test results: claude-3 / researcher
SHA tested: f6579e0 (src/ identical to 4d455584; only docs/README/userscript.js at repo root changed since).
Runtime: wrangler 4.153 `dev --local` (workerd, local D1, real DOs) on a COPY of src/gats-community in /tmp; Node v22.22.2. No Cloudflare deploy, no browser.

| id | scenario | how run | result | notes |
|---|---|---|---|---|
| C3-1 | unit suite | `npm test` in src/gats-community | PASS 27/27 | node harness, fake D1/DO |
| C3-2 | G userscript replay | `node scratch/claude-1/replay.mjs` | PASS 9/9 | recorded frames, not a browser |
| C3-3 | A,B,C,E,D-basic smoke | scratch/fifth-1/tests/smoke-canonical-gats-community.mjs, workerd | PASS 21/22 | the 1 FAIL is a stale expectation: script expects 429 by try 12, current IP limit is 20 per 900 s; 429 starts at try 21 (C3-4) |
| C3-4 | F sequential IP gate | scratch/claude-3/burst.mjs part 1 | PASS | 20x401 then 429 from try 21, matches limit 20 |
| C3-5 | F parallel burst, 1 account, 200 IPs | burst.mjs part 2 | FAIL (bounded) | account limit 10: 20x401 let through, 180x429. Owner correct login from fresh IP then got 429 (lockout griefing confirmed in real DO) |
| C3-6 | F parallel burst, 1 IP, unknown users | burst.mjs part 3, burst-ip.mjs (6 trials) | FAIL | IP limit 20: trials let through 50/50, 49/100, 68/200, 200/200, 30/30, 200/200 (401s); gate locks afterwards (next try 429). Check-then-fail TOCTOU is real in workerd, overshoot up to 10x. See #31 |
| C3-7 | D 100+ sockets, hibernation timing, alarm sweep revoke | NOT RUN | | needs a longer run |
| C3-8 | I docs walkthrough, real Cloudflare deploy, browser/Tampermonkey | NOT RUN | | user-dependent |

Repro: copy src/gats-community to /tmp/gc, `npm i -D wrangler`, wrangler.test.toml with a fake d1 id, `.dev.vars` (TOKEN_SECRET, PEPPER, ADMIN_KEY), apply schema.sql then schema_002.sql with `wrangler d1 execute --local`, `wrangler dev --local --port 8788`, then `node scratch/claude-3/burst.mjs` and `burst-ip.mjs` (copy into /tmp/gc).
