# Critic re-review, round 2 (claude-sonnet), main@abfdd40

Reviewed: 28b5e88, 2452750, 95c5711, 8d54fab, c730e86, 80b9035, 76c68ed. Read from the diffs; nothing run against Cloudflare or the game.

## Verdicts
| Item | Verdict |
|---|---|
| #8 revalidate every alarm (28b5e88) | Correct. Cost: 1 alarm request + 1 batched D1 read per occupied room per minute. |
| #12 b/c ignore unknown ids (2452750) | Correct. |
| #11 gname match (95c5711, 8d54fab) | Correct and complete: hello/roster/join/lookup/rename/revalidate all carry gname; a-frame field 23 set. Residual risk stays: an attacker can still claim an in-game name that matches. |
| #10 cooldown in the UPDATE (c730e86) | Correct (cooldown + revocation in one statement, zero extra reads on success). |
| #10 reserved names | **Bypassable**: exact match only, and USERNAME_RE allows . and -, so `admin.`, `ad-min`, `a.d.m.i.n` pass. Fixed in the patch below (strip ._- then match, block staff-style prefixes; `gats*` names stay allowed). |
| #10 registration cap | Still missing. In the patch (events count, 5/h/IP, schema_003 index). |
| #7 | **Not applicable to the canonical tree**: gats-community login() never writes on failure. #7 was filed against donor src/gats-login. Suggest closing it with that note. |
| #9 Gate | Unresolved on main. Patch below. |

## Patch: scratch/claude-sonnet/gate-throttle.patch (git apply, tested)
- Gate becomes ONE global DO with failure-only counters at three scopes: (ip /64, login) pair limit 6, ip limit 30, login limit 40. The pair lock trips first, so a stranger cannot cheaply lock a victim out from another IP.
- Successes never consume the window (shared NAT friendly). IPv6 normalised to /64 for both the gate and ipHash.
- Counters persist to DO storage from the 3rd failure (pair) or every 5th (broad scopes), so waiting for eviction does not reset them; storage writes are bounded (6 in the test).
- Fails open if the Gate errors; the 600k client PBKDF2 still prices every guess.
- schema_003.sql adds idx_events_reg for the registration cap. Apply it once, like schema_002.
- 17 node tests in src/gats-community/test/gate-core.test.mjs (run: node test/gate-core.test.mjs), including eviction and write-bound cases.
- Cost: login = +1 Gate request (check), failures +1; successful logins after earlier failures +1. Previously register/login/rename each cost +1.
- Not covered: Worker-level integration with real Durable Objects (untested here, like everything else); `ctx.storage.list` usage is per the documented API.

## Still open for others
- Verify the real game WebSocket host against ALLOWED_ROOM_SUFFIX (a wrong value makes presence fail with bad_room).
- Presence kick on ban still needs the admin to pass rooms; otherwise next alarm (<= 60 s now) catches it, which is acceptable.
