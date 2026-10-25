# Design doc (from the user, verbatim)

Client side (the userscript)

* It runs inside Tampermonkey on gats.io. It keeps your signed token in `GM_setValue` storage, which the game page's own scripts can't read.
* It calls the worker for login, rename and lookups. It sends the token in an `Authorization` header, using `GM_xmlhttpRequest` if CORS gets in the way.
* After login it opens one WebSocket to `/presence`. That socket carries heartbeats, join and leave events, and username lookups for other players.
* It caches what it learns (names it has already resolved) locally, so repeat lookups cost the server nothing.

Server side
Worker (`login-info-handler`) is the front door and holds no state. It handles `/login`, `/rename` and `/presence`, and it signs and verifies tokens with an HMAC secret kept in a wrangler secret. It decides where each request goes.
D1 is the durable record: a users table (id, username, credential data, ban flag, token version) and an append-only `events` table for logins and renames. It's written rarely, only for signups, renames, bans and meaningful events.
Durable Object holds the hot state, using hibernating WebSockets. It keeps a map of who's connected, their display names and last-seen times in memory, and broadcasts joins and leaves. I'd use one object per game server or room, named after the gats server. Nothing here touches SQLite unless something must survive a restart.
The arrow between the DO and D1 is the fallback path: if the DO doesn't know a username, it reads D1 once and caches the result.
The four flows

1. Login: the userscript sends `POST /login`, the worker checks D1, and the worker returns a signed token containing the user id, name and expiry. This costs a D1 read and at most one logged write.
2. Authenticated calls: the worker verifies the signature and expiry with no database hit. To support revocation, compare the token's version against a number cached in the DO, so bans take effect without a D1 read per request.
3. Rename: `POST /rename` is verified, then one D1 update plus one event row, then the worker tells the presence DO to update the name live.
4. Presence: the WebSocket upgrade is verified by the worker and forwarded to the room's DO. Heartbeats stay in memory, and the 20:1 billing ratio keeps them cheap.

What lives where

* Durable and rarely written: accounts, bans, name history, in D1.
* Hot and constantly changing: who's online, last-seen, in DO memory.
* Per-user and private: the token and preferences, in the userscript.
* Secrets: the HMAC key, in the worker's secrets, never in client code.

One open question is how users authenticate to `/login`. If it's a password, hashing it in a Worker can run into the free plan's CPU-per-request cap, so test it early. If it's Discord or another OAuth sign-in, you can skip storing credentials entirely. Which are you planning?
