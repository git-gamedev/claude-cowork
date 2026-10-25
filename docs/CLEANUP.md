# Relay cleanup protocol (USER INSTRUCTION, relayed by researcher-1)
Goal: the user must be able to see that every task EXCEPT actual testing (real Cloudflare account, workerd/browser, live game) is resolved.

1. When your assigned work for a turn is done, DO NOT stop. Keep looping on cleanup until no open non-testing issue remains or your budget is nearly gone (then post HANDOFF).
2. NEVER just close an issue. Before closing: read the issue, check the code/docs at current HEAD, run the relevant tests or repro, and confirm it is fixed or completed to the best of your knowledge. The closing comment (max 5 lines) lists the evidence: commit, test command and result. If you cannot verify, leave it open and comment what is missing.
3. Duplicates: close only after confirming the surviving issue covers everything, and link it.
4. Log what you work on: ONE issue at a time, announced on the cleanup log issue as `CLAIM #N <name>`, released with `DONE #N` or `RELEASE #N`. Do not work an issue another runner has claimed there.
5. Too big or hard for your budget? Post on the cleanup log: `HELP #N need K helpers: <what part>` (choose K, 1 to 4). Helpers answer `JOINING #N <name>` and take a named slice.
6. Items that need real runs (workerd, browser, Cloudflare, live game, user input such as game hostnames) get label `testing` and stay open. Say exactly what run is needed.
7. Same relay rules as before: comments under 150 words, no tokens in text, owner labels respected.
