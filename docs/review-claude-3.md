# Security + behavior review at 5f7d816/3b3e7d6 (claude-3, researcher) for #28 / #34
Scope: src/gats-community/src/{worker,room,gate}.js read in full; workerd (wrangler 4.153 `dev --local`) runs, Node 22. Not run: real Cloudflare, browser.

## Findings
| # | sev | finding | status |
|---|---|---|---|
| 1 | med | One IP could exhaust the shared daily signup cap: `throttleRegister` hit the per-IP and global gates in parallel and before body validation, so 310 garbage requests from one IP made every legit signup get 429 until UTC midnight (workerd repro scratch/claude-3/regcap-dos.mjs) | FIXED, issue #47 (per-IP gate first, validate, then count the global cap); unit test red without fix, green with |
| 2 | low-med | `/admin/ban` had no throttle: 150 wrong keys from one IP all returned 401 (strength of ADMIN_KEY was the only protection; docs said only "long random") | FIXED: per-IP Gate (10 fails/15 min, `/try` reservation); docs now give `openssl rand -base64 48` |
| 3 | low | Reserved-name bypass `roo7/gat5/suppor7` | fixed earlier (037a277), #32 |
| 4 | info | Login Gate slots reserved by `/try` leak if the worker throws between `/try` and `/fail|/ok|/done` (D1 error): not permanent, Gate drops unreleased slots after 30 s | accepted |
| 5 | info | `/rename`: if the audit-log insert throws after the UPDATE succeeded, client gets 500 though the name changed (token still has the old name until `/refresh`) | open, minor, not filed |
| 6 | info | `verifyToken` does not check ban/token_version; revocation is enforced by `/refresh` and the Room sweep (<= ~5 min unless admin passes `rooms`) | accepted, documented |
| 7 | info | Existence oracles: register 409 for taken names; after 10 failures on an account, login returns 429 for it vs 401 for unknown names | accepted (handoff lists it) |
| 8 | info | Presence accepts connections with no `Origin` header (non-browser clients); token is the real auth | accepted |
| 9 | info | Room has no per-socket rate limit: one client can make the Room broadcast 400 join/leave events in ~2.5 s (200x hello/bye) | open, cost note for #34 |

## Checked and fine (no finding)
HMAC verify is constant-time; `readBody` caps at 2 KB incl. chunked; token and PEPPER slots bounded (2 each); Gate `/try` has no await between check and push so it is atomic per Gate; Gate stops writing once locked and alarm cleans idle keys; rename UPDATE enforces ban, token_version and cooldown atomically; x-uid/x-name/x-tv are overwritten from the verified token before reaching the Room; admin ban increments token_version.

## #34 independent runtime check (workerd, not Node-fake)
120 sockets in one room: open ~0.6 s, 120 hellos ~2.4 s, roster/joins complete; frames >2 KB, malformed JSON and binary ignored without closing; lookup capped at 50 ids; ping/pong auto-response works; 200x hello/bye storm delivers all 400 events and ends consistent. No behavior regression found in the optimized paths (smoke v2 23/23, npm test 37/37, replay 9/9). No MB heap figure is claimed: workerd's per-isolate heap is not exposed by `wrangler dev`.
