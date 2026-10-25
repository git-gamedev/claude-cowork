# Tester pass (all roles act as testers)

Target: `src/gats-community` at the SHA announced on #1 (baseline `02c7a7b`; re-run the same slice on the optimized SHA once planner posts it).
Rules: do not edit `src/`. Put scripts under `scratch/<your-name>/`, results in `docs/test-results/<your-name>.md`. Report only what you actually ran
and say HOW (node harness, jsdom, `wrangler dev --local`/workerd). File a `[bug]` issue only for reproduced failures (cap 3), with exact steps.

## Scenarios
A. Happy path: register -> refresh -> login -> two presence clients -> hello/roster/join/lookup/bye/leave.
B. Auth abuse: forged/expired/tampered tokens, wrong password x N (429 + body unchanged), unknown user vs wrong password (same response and similar timing),
   username edge cases (unicode, `,` `|`, 2/17 chars, case-variant duplicates, reserved names), key format (42/44 chars, bad alphabet), oversized and chunked bodies.
C. Revocation: ban with `rooms` (instant kick), ban without (next sweep), unban, token-version mismatch after ban, banned user cannot reconnect.
D. Presence: pid_taken, pid steal attempt, second connection from same account (replaced), rapid hello/bye loops, >2 KB frame, malformed JSON, binary frame,
   100+ sockets in one room, ping/pong auto-response, server eviction/hibernation then message, client reconnect backoff.
E. Rename: cooldown, two concurrent renames, collision with existing name, live rename push to other sockets.
F. Limits: parallel burst of failed logins (#9 TOCTOU), signup cap (`MAX_REG_PER_DAY`), per-IP register/rename limits, login audit soft cap, IPv6 /64 grouping.
G. Userscript: frame decode (delta frames, `d` before `c`, `e` removal, respawn `a`), name swap, no phantom ghost from `b`/`c`, no blank `d` injection,
   presence socket never tapped by our own hook, logout clears session.
H. Resource use: heap and per-request allocations under load (N sockets, many requests), no unbounded Maps, large bodies.
I. Docs walkthrough: follow INSTRUCTIONS.md literally as a new user; list every step that is wrong, missing or unverifiable.

## Result format (docs/test-results/<name>.md)
`| id | scenario | how run | result PASS/FAIL/NOT RUN | notes/issue |`  and one line: SHA tested.

## Suggested assignment
claude-sonnet: B, F (burst vs real workerd). fifth-1: A, C, E, D-hibernation in workerd. researcher-1: H, quotas. claude-1: G, I.
implementer-1 (budget-limited): D load/edge cases if budget allows. sonnet-1 (planner): D, H on the optimized build + regression.
