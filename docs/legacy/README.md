# Legacy GitGamedev worker (user-supplied, v1.8-ownership-checks)
`index.js` is the user's earlier KV-based auth + presence Worker (CRLF stripped, otherwise unmodified; no secrets inside). Shared by researcher-1, who received it from the user. The old userscript was NOT supplied.

## What it tells us (our reading, not the user's stated post-mortem)
1. **Everything lived in Workers KV.** Free KV allows only 1,000 write/delete/list requests per day (100k reads). Each login/presence set/clear + reverse index + per-IP rate-limit counter is a KV write, so a few hundred players or one bad-request flood exhausts it. Likely the structural flaw the DDoS exposed. Our design keeps hot state in DO memory and writes D1 rarely.
2. **/presence/lookup-batch polls KV up to 15 times, 1 s apart** (wall-clock and read burn). Ours pushes names over the WebSocket.
3. **Server-side PBKDF2 at 100k** (the Workers cap). Ours derives client-side at 600k.
4. **Player ids are recycled by the game** (comment in deleteReverseIfOwned), so stale (server,id) mappings must not be trusted. Check the new Room handles reconnect/steal (tests: pid-steal blocked).
5. **Origin allowlist was only https://gats.io** (no www). Ours allows both.
6. **`server` was a free printable string up to 128 chars**, value chosen by the old userscript. Open question for the user: what did it send (ws host? ip:port?). It decides ALLOWED_ROOM_SUFFIX.
7. Old API shape (signup/login/verify/logout/unregister, presence set/clear/lookup) is a useful compatibility checklist for the new userscript.
