# gats.io community login: setup and operations guide

Everything here runs on Cloudflare's free tier plus Tampermonkey. No paid services, no email, no OAuth app.

## 1. What you are deploying

| Piece | File | Job |
|---|---|---|
| Userscript | `gats-community-login.user.js` | Login UI, token in `GM_setValue`, hooks the game socket, one presence socket to the worker |
| Worker | `src/index.js`, `src/lib.js` | Stateless front door: `/prelogin /signup /login /refresh /rename /logout_all /unregister /presence /admin/*` |
| Durable Object `AuthCache` | `src/auth-cache.js` | Hot copy of "is this user banned / which token version / current name", with a D1 read as fallback |
| Durable Object `PresenceRoom` | `src/presence-room.js` | One per game server. Hibernating WebSockets, roster of who is connected, join/leave/rename broadcasts |
| D1 | `schema.sql` | `users` (durable accounts) and append-only `events` |
| Config | `wrangler.toml` | Bindings, migrations, vars |

### Answer to the open question: how users authenticate

I chose **username + password with the stretching done in the userscript**, not Discord OAuth. Reasons:

- Workers on the free plan get about 10 ms CPU per request. A properly strong password hash (PBKDF2 at 300k+ iterations, or scrypt/argon2) will not fit. So the userscript runs PBKDF2-SHA256 (310,000 iterations, WebCrypto, a few hundred ms in the browser) and sends only the derived 32-byte key.
- The worker then applies one cheap HMAC with a secret `PEPPER` and stores that. Cost on the worker is microseconds.
- The server never sees the password. If D1 leaks, an attacker still needs the pepper *and* has to run PBKDF2 per guess.
- Each account has its own random salt, stored in D1 and handed out by `/prelogin`. Unknown usernames get a deterministic fake salt so the endpoint doesn't reveal which names exist.
- Because the salt is not tied to the username, renaming never breaks login.

Trade-off: there is no email, so **there is no password recovery**. If someone forgets their password, you delete their row (section 7) and they re-register. Discord OAuth would fix that, and it is a straightforward later addition: replace `/login` and `/signup` and keep everything else.

## 2. Prerequisites

- A Cloudflare account (free) and Node.js 18+.
- Tampermonkey in Chrome/Edge/Brave (recommended, see section 8 for caveats on other browsers).
- Open a terminal in this folder and run `npm install --save-dev wrangler` (or just use `npx wrangler` everywhere below).

## 3. Deploy the backend

```bash
npx wrangler login

# 1. Create the database, then copy the printed database_id into wrangler.toml
npx wrangler d1 create gats-login

# 2. Create the tables (--remote targets the real database, not the local sim)
npx wrangler d1 execute gats-login --remote --file=schema.sql

# 3. Secrets. Generate each with: openssl rand -base64 48   (any long random string works)
npx wrangler secret put TOKEN_SECRET
npx wrangler secret put PEPPER
npx wrangler secret put ADMIN_KEY

# 4. Deploy
npx wrangler deploy
```

Notes:

- The worker is named `login-info-handler`, the same as your existing one, so `wrangler deploy` replaces its code. Bindings and vars now come from `wrangler.toml`; if you previously added any in the dashboard, re-add them to the file or they will be dropped.
- **Back up `PEPPER`.** If you lose or change it, every stored password stops matching and everyone must re-register. Changing `TOKEN_SECRET` is harmless: it just logs everyone out.
- Check it is alive: `curl https://login-info-handler.gitgames.workers.dev/` should print `{"ok":true,"service":"gats-login"}`.
- Live logs: `npx wrangler tail`.

## 4. Find the real game-server host (important, one minute)

Presence rooms are named after the game server's host, and the worker only accepts hosts ending in `ALLOWED_ROOM_SUFFIX` (default `gats.io`). I could not check what URLs the live game actually opens, so verify:

1. Open gats.io, press F12, Network tab, filter **WS**, join a game.
2. Look at the game socket's URL (ignore any `/ping` ones). Note the host, for example `something.gats.io`.
3. If the host does not end in `gats.io`, set `ALLOWED_ROOM_SUFFIX` in `wrangler.toml` to its parent domain and run `npx wrangler deploy` again.

You can also set `DEBUG: true` in the userscript's `CFG` to log what it sees.

## 5. Install the userscript

1. Tampermonkey dashboard, Create a new script, paste the contents of `gats-community-login.user.js`, save.
2. If you rename or move the worker, change `WORKER_URL` in `CFG` **and** the `@connect` line in the header.
3. Reload gats.io. A small badge appears bottom-left. Click it, create an account, join a game: the dot turns green when the presence socket is connected.

Test with two browsers (or one normal and one incognito profile) on the same game server: each should see the other's community name above their character.

## 6. How it works

### The four flows

1. **Login.** Userscript `POST /prelogin` (gets salt + iteration count), derives the key locally, `POST /login`. Worker reads D1, compares in constant time, writes `last_login_at` plus one `login` event in a single batch, returns a signed token.
2. **Authenticated calls.** Worker verifies the HMAC signature and expiry locally (no database). It then asks the `AuthCache` object whether that user's `token_version` is still current and the account not banned. `AuthCache` answers from memory and only reads D1 when it has no fresh entry (10 min TTL).
3. **Rename.** Verified, then one D1 batch (update + `rename` event, 24 h cooldown, unique-name enforced by the database), then `AuthCache` pushes the new name into the user's room so everyone sees it live.
4. **Presence.** Userscript opens `wss://…/presence?room=<game host>` and passes the token as a WebSocket subprotocol (browsers cannot set headers). The worker verifies, strips the token and forwards to that room's object with trusted identity headers.

### Token format

`v1.<base64url payload>.<base64url HMAC-SHA256>`. Payload: `uid`, `name`, `tv` (token version), `iat`, `exp` (7 days). The name in the token is informational; the live name always comes from `AuthCache`. Tokens are refreshed on every page load via `/refresh`.

### Revocation

Banning or "log out everywhere" bumps `users.token_version`. Old tokens fail the `AuthCache` comparison. `AuthCache` remembers each user's last room (one tiny key-value write when it changes) and tells that room to disconnect the user immediately.

### Presence protocol (JSON over the socket)

| Direction | Message |
|---|---|
| client → room | `ping` (answered `pong` by the runtime without waking the object; also gives last-seen) |
| client → room | `{t:"claim", gid, gname}`: "my in-game id and name on this server" (sent on every `a` frame) |
| client → room | `{t:"lookup", ids:[…]}`: fallback for players it could not resolve (3 tries, backoff 2 s / 8 s / 30 s) |
| room → client | `roster` on connect, then `join`, `leave`, `rename`, `names`, `denied`, `kick` |

The roster and join pushes mean lookups are rarely needed. The userscript keeps what it learns in memory for the session, so repeated sightings of the same player never hit the server.

### How names appear in-game

Only people running the userscript see community names. The userscript rewrites the `a` frame (your own name) and `d` frames (other players) as they arrive, and re-injects a `d`+`c` pair when a name resolves after the player already spawned. Other players without the script see your normal in-game name.

## 7. Operating it

### Ban / unban

```bash
curl -X POST https://login-info-handler.gitgames.workers.dev/admin/ban \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"username":"SomePlayer","reason":"cheating"}'

curl -X POST https://login-info-handler.gitgames.workers.dev/admin/unban \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"username":"SomePlayer"}'
```

A ban disconnects the player from presence at once and blocks login.

### Useful D1 queries

```bash
npx wrangler d1 execute gats-login --remote --command "SELECT username, banned, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 20"
npx wrangler d1 execute gats-login --remote --command "SELECT ts, type, user_id, detail FROM events ORDER BY id DESC LIMIT 50"
# Forgotten password: delete the account so the name can be registered again
npx wrangler d1 execute gats-login --remote --command "DELETE FROM users WHERE username_lc = 'someplayer'"
```

Deleting a row directly takes effect for cached tokens within 10 minutes (the `AuthCache` TTL).

### Rotating secrets

| Secret | Effect of changing |
|---|---|
| `TOKEN_SECRET` | Everyone is logged out, nothing else |
| `ADMIN_KEY` | Only affects your curl commands |
| `PEPPER` | **Breaks every password.** Don't, unless you intend to wipe accounts |

## 8. Limits, security notes, known gaps

- **Not tested against the live game.** I wrote the hooks from the protocol notes and your skeleton and checked the code for syntax and the shared helpers by running them, but I could not run the userscript on gats.io or deploy to Cloudflare. Expect to do a first-run pass using the checklist below.
- **Presence claims are trust-on-first-claim.** A client says "I am in-game id 12 named X". The room accepts the first claim for an id while that socket is alive, and other clients only show the community name if the claimed in-game name matches what the game's own `d` frame says (`STRICT_NAME_MATCH`). A determined user who knows another player's id and exact name could race to claim it first. The game server gives us nothing to verify against, so this is a cosmetic-trust system: **don't use community names for anything that needs real authority** (bans, rewards) without extra checks.
- **Page CSP / browsers.** The presence socket is opened from the userscript to `workers.dev`. If gats.io ever sets a strict `connect-src` CSP, that connection can be blocked in some browsers (Firefox is stricter than Chrome here). Symptom: badge never turns green and the console shows a CSP error. Also, hooking `WebSocket` through `unsafeWindow` is well-trodden in Tampermonkey on Chrome; I'd treat Firefox as unverified.
- **Abuse limits built in:** 3 sign-ups per IP per hour (IPs stored only as truncated HMACs), account lockout for 10 min after 8 wrong passwords, 30 presence messages per 10 s per socket, message size cap, rename cooldown of 24 h, reserved names (`admin…`, `gats`, …). Lockout means someone can annoy a victim by repeatedly failing their login; acceptable here, tune `LIMITS` in `src/lib.js`.
- **Password strength is enforced only in the userscript** (8+ chars), because the server never sees the password. A modified client could register a weak one.
- **Free-tier budget (check Cloudflare's current pricing page, limits change):** Workers 100k requests/day; Durable Objects 100k requests/day plus duration, with WebSocket messages billed at roughly 20:1; D1 about 5M reads and 100k writes/day. A session costs about 3 worker requests (prelogin, login, refresh), one presence upgrade, and then only claim/lookup messages; pings are auto-answered and sleeping objects aren't billed for duration. Writes happen only on signup, login, rename, ban, and failed-password counters.
- **One global `AuthCache` object** handles every auth check. Fine for a community this size; shard by user id if you ever approach a thousand checks per second.

## 9. First-run checklist

1. `curl` the health URL (section 3).
2. In the script's `CFG`, set `DEBUG: true`; open DevTools console on gats.io.
3. Register, log out, log in again, close and reopen the tab (should stay logged in).
4. Join a game: badge dot turns green. If not, check `npx wrangler tail` for `bad_room` (fix `ALLOWED_ROOM_SUFFIX`) or the console for a CSP error.
5. Second browser, same server, different account: names show up above each other's players.
6. Rename one account: the other browser updates live.
7. Ban the second account with the curl above: it is kicked from presence within a second.
8. Set `DEBUG` back to `false`.

## 10. Ideas for later

Discord OAuth in place of passwords; a `/change_password` endpoint (client derives old and new keys); a read-only `/online?room=` endpoint; an alarm in `PresenceRoom` to sweep stale sockets on a timer instead of on each claim.
