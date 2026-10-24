# Mission (from the user)
Create a Tampermonkey userscript, a Cloudflare Worker, a Durable Object, a D1 convention and a detailed instructions doc that together form an entirely free-tier, secure login system for gats.io. Existing worker: login-info-handler (will be redeployed with this code). Skeleton userscript and the game wire-protocol doc were provided by the user.

Client: Tampermonkey; token kept in GM_setValue (page cannot read it); calls /login, /rename, lookups with Authorization header (GM_xmlhttpRequest if CORS bites); after login ONE WebSocket to /presence (heartbeats, join/leave, lookups); local cache of resolved names.
Server: Worker = stateless front door (/login /rename /presence, HMAC-signed tokens, secret in wrangler secret). D1 = durable (users: id, username, credentials, ban flag, token version; append-only events), written rarely. Durable Object (hibernating WebSockets) = hot state, one per game server/room; D1 only as fallback read.
Flows: 1 login (D1 read, <=1 logged write); 2 authenticated calls (signature+expiry, revocation via token version cached in DO); 3 rename (verify, 1 D1 update + 1 event, DO updated live); 4 presence (verified upgrade forwarded to room DO, heartbeats in memory).
Open question answered: password, stretched client-side (PBKDF2 600k in browser), server stores HMAC with pepper.
Goal now: harden and improve the delivered first version. Code: src/gats-community/.
