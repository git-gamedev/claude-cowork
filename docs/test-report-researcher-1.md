# Tester report: quota simulation (researcher-1, 2026-10-25)
Tool: scratch/researcher-1/quota-sim.mjs, run against the canonical worker via the test harness (real SQLite, in-process Gate/Room). Results: scratch/researcher-1/quota-sim-results.txt. D1 and DO rows are ESTIMATES (1 table row + 1 per index touched), not Cloudflare meter readings. Not run: real workerd, live game, browser.

| Scenario | Worker req | DO req | D1 rows | DO rows |
|---|---|---|---|---|
| A 100 players x2 logins | 312 | 820 | 1,260 | 828 |
| A 300 players x3 logins | 1,236 | 3,360 | 4,680 | 3,084 |
| A 1000 players x3 logins (signup cap raised to 1000) | 4,120 | 11,200 | 15,600 | 10,280 |
| B spray 5,000 random names, 200 IPs | 5,000 | 9,000 | 0 | 8,000 |
| C 2,000 guesses at one account, one IP | 2,001 | 4,022 | 6 | 44 |
| D one account, 500 successful logins | 501 | 1,502 | 66 | 1,004 |
Free limits: 100k each. A normal day for 1000 players uses ~16% of the tightest pool, before room alarms (<=288/day/active room at 300 s).

## Results
- PASS: failed logins write nothing to D1 (B, C). Audit rows capped: 500 successful logins wrote 20 events (60 rows) instead of ~1,500 (D).
- PASS: unknown-name spray only touches the per-IP Gate, so random names cannot create account Gates (B).
- CONFIRMED (critic round 3): lockout griefing. After 2,000 guesses from one IP, the real owner logging in from a DIFFERENT IP got HTTP 429 for 15 min (C). Existing 7-day tokens and /refresh are unaffected. Suggest per-(account, ip bucket) limit of ~10 plus a looser global per-account limit (~100) so one attacker cannot lock out the owner.
- LIMIT: Gate protection is per source IP. 4,000 failures passed before the 200 IPs locked (B: 20 each), costing 8,000 DO rows. A botnet of 5,000 IPs could burn ~200k DO rows, past the free pool; the Worker request cap (100k/day) bounds it anyway. Only a Cloudflare rate-limiting rule (needs a custom domain on Cloudflare) stops this. Gates fail open, so logins keep working if the pool runs out.
- Sim artifact fixed: 2-character usernames were rejected by USERNAME_RE (min 3), not by the signup cap.
