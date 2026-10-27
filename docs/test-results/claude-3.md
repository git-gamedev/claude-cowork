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

## Round 2: after other instances' fixes (real workerd, wrangler 4.153 `dev --local`, fresh local D1 per run)
| id | scenario | how run | result | notes |
|---|---|---|---|---|
| C3-9 | F parallel burst, 1 IP/unknown users, 6 trials N=30..200 | scratch/claude-3/burst-ip.mjs at 7435a16 | PASS | exactly 20x401 then 429 every trial (was 30..200 let through at f6579e0). #31 TOCTOU fixed by Gate `/try` |
| C3-10 | F parallel burst, 1 account, 200 IPs | burst.mjs at 7435a16 | PASS | exactly 10x401 then 429 (was 20). Owner still gets 429 from a fresh IP for 15 min = accepted lockout-griefing limit |
| C3-11 | B reserved names at b4e1167/7435a16 | reserved-and-d.mjs | FAIL | 17/20 variants rejected; `roo7`, `gat5`, `suppor7` registered (200): canonName stripped trailing digits BEFORE folding look-alikes |
| C3-12 | B reserved names after claude-3 fix (fee341a + worktree patch) | reserved-and-d.mjs | PASS | 20/20 probes 409, 12/12 legit names 200 (adminton, Alice, Sysadmin, Rooted, Gatsby, Lola, Player007, Mod2k, ...). Fix: two canonical forms (strip-digits-then-fold, fold-then-strip-digits). npm test 35/35, replay 9/9 |
| C3-13 | D 120 sockets, one room | reserved-and-d.mjs | PASS | 120 sockets open ~0.6 s; 120 hellos ~2.4 s; roster and joins complete |
| C3-14 | D bad frames | same | PASS | >2 KB, malformed JSON, binary frame silently ignored, socket stays open; bad pid -> err bad_pid; lookup of 200 ids capped at 50; ping -> pong |
| C3-15 | D hello/bye storm 200x | storm.mjs (2 and 32 sockets), 20 s wait | PASS | observer got 200 joins + 200 leaves, final state consistent. Earlier "state consistent" FAIL in reserved-and-d.mjs was a too-short wait with 120 sockets (delivery lag), not a bug; wait lengthened |
| C3-16 | D hibernation/eviction, alarm revocation | NOT RUN here | | researcher-1 claimed #30 |
Note: server side has no per-socket rate limit on hello/bye (a client can make the Room broadcast 400 events in ~2.5 s). Cost/abuse note for #34, not filed as a bug.

## Round 3 (HEAD 3b3e7d6 + claude-3 patches)
| id | scenario | how run | result | notes |
|---|---|---|---|---|
| C3-17 | F one IP burns global signup cap | scratch/claude-3/regcap-dos.mjs, workerd | FAIL before / PASS after | before: 310 garbage requests from one IP -> all legit signups 429 (#47). after fix: legit users on 3 fresh IPs get 200 |
| C3-18 | B admin-key brute force | scratch/claude-3/admin-brute.mjs, workerd | FAIL before / PASS after | before: 150x401, never 429. after: 10x401 then 140x429 |
| C3-19 | regression | researcher-2 smoke-canonical-v2.mjs on workerd, npm test, replay | PASS | 23/23, 37/37, 9/9 |
