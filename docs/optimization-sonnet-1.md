# Memory/allocation optimization (sonnet-1) - src/gats-community

Measured in Node 22 (same V8 as workerd) with the repo's fake sockets whose `deserializeAttachment()` structured-clones like the real runtime.
NOT measured in workerd or on Cloudflare; absolute heap figures there will differ. Reproduce: `scratch/sonnet-1/bench.mjs`, `gcbench.mjs`; baseline code = `scratch/sonnet-1/baseline/` (= `02c7a7b`).

| What | Before | After |
|---|---|---|
| Attachment clones for 150 sockets doing hello + lookup + bye + sweep (450 ops) | 68,250 | 150 (one per socket per wake) |
| Same workload, wall time (fake env) | ~105 ms | ~9 ms |
| GC events, 40 rounds of the 150-socket workload | 600 | 36 |
| base64url enc+dec, 800k calls | 847 ms | 215 ms |

(Heap-MB deltas from `process.memoryUsage()` were within noise for this short-lived garbage, so no MB saving is claimed.)

## Changes
Room (`room.js`)
- Root cause: `ws.deserializeAttachment()` clones the attachment on every call and every handler looped over all sockets (hello, lookup, rename, kick, roster, sweep, replace). Cost was O(N) clones per message.
- One index per wake: `uid -> {ws, a}` and `pid -> uid`; handlers mutate the live object. `sid` in the attachment keeps a late close event of a replaced socket from evicting its replacement.
- Attachment is re-serialized only when pid/gname/name change; `seen` is memory-only (runtime timestamps pings; see trade-off below).
- User cache bounded at 256 with oldest-first eviction (was clear-at-2000), records updated in place; SQL placeholder strings built once per size; no `URL` object per internal request; no `Set`/array copies in revalidate.

Worker (`worker.js`) / Gate (`gate.js`)
- Two fixed HMAC key slots instead of a Map keyed by secret (claude-1 / researcher-1, #15: measured 2 `importKey` calls per login with a single slot; adopted here after a merge conflict where we had optimized the same files in parallel).
- `readBody`: hard 2 KB cap into one fixed buffer, also for chunked bodies (before: only `Content-Length` was checked, then `req.json()` buffered everything).
- Room regex, allowed-origin Set compiled once per config value (before: `new RegExp` and `split().map()` per request).
- base64url without per-byte string concatenation or three chained regex copies; single `TextDecoder`; shared header init object; Gate reply helper hoisted.

## Trade-offs / limits
- `seen` is not persisted on every message. After a hibernation wake a client that never pings and only sends occasional lookups could look stale; the shipped userscript pings every 25 s and pings are timestamped by the runtime, so it is not affected.
- The index lives only for one wake; first message after hibernation pays N clones once.
- Free-plan Workers memory is 128 MB per isolate; this system was never near it, so the gain is mainly CPU time and GC pressure, which is what the free CPU cap cares about.
- Tests: `npm test` = 27 pass (6 new in tests/optimize.test.mjs). No real-workerd run by me yet.
