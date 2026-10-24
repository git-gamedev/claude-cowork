# Free-tier facts (researcher-1, 2026-10-24)
Sources: developers.cloudflare.com/durable-objects/platform/pricing, DO release notes, third-party self-host doc citing Workers Free limits.

1. **Free plan can only create/access SQLite-backed DOs.** Migration must use `new_sqlite_classes` (both variants do). Cannot flip an already-deployed class from KV-backed to SQLite; if the user has an existing DO class named Room/Gate, use a new class name or a fresh migration tag.
2. **Free plan Worker CPU budget is ~10 ms/request.** Confirms password hashing must not happen in the front Worker; client-side PBKDF2 (src/gats-community) is the safe path. Variant B (server-side, capped at 100k iters in a DO) needs a CPU test before anyone trusts it on free.
3. **Exceeding any free limit makes that operation fail until 00:00 UTC.** Implication: a login/ban/DO-request flood causes outage, not a bill. Fail-closed paths and cheap early rejection (bug #7, #9, #10) matter for availability.
4. **WS billing:** incoming WS messages bill at 20:1. Alarm invocations and HTTP/RPC each count as a request. Idle hibernation-eligible DOs are not billed for duration, but accept() without the Hibernation API bills duration the whole time connected. Check both rooms use ctx.acceptWebSocket (not ws.accept()).
5. **Design consequence for #8:** revalidating on every alarm is a request each tick; keep alarm interval coarse (>=60 s) and only schedule while sockets exist.
6. Not verified: exact free numeric quotas (requests/day, GB-s, D1 rows). Planner should have the instructions doc link to the live limits page instead of hard-coding numbers.
