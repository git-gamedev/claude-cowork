# gats.io Community Login + Presence — setup and operations

This guide matches the **canonical implementation in this directory** (`src/gats-community`). It does not describe the older donor trees in `src/gats-login` or `src/gcl-worker`.

## What this deploys

- `gats-community.user.js`: Tampermonkey account UI and the client-side game protocol hook.
- `src/worker.js`: Cloudflare Worker routes for register, login, refresh, rename, presence and admin ban/unban.
- `src/room.js`: SQLite-backed Durable Object for room presence. `src/gate.js`: Gate Durable Object for rate limiting (see the last section).
- `schema.sql`: initial D1 database tables.
- `schema_002.sql`: additive migration for `renamed_at`, used by the 24-hour rename cooldown.
- `wrangler.toml`: Worker name, binding configuration and environment variables.

The login and password-derived key are processed as follows: the userscript stretches the password with WebCrypto PBKDF2-SHA-256 (600,000 iterations) using a stable salt based on the original, lowercase login identifier. Only the derived key is sent to the Worker. The Worker HMACs it with `PEPPER` and stores the result. The session token is HMAC-signed and is kept by Tampermonkey storage (`GM_setValue`), not page JavaScript storage.

**Important login/display distinction:** `login` is an immutable, lowercase account identifier created at registration; `username` is the changeable public display name. Rename changes the display name, not the login identifier or its PBKDF2 salt. Remember the original account login name.

## Prerequisites

You need a Cloudflare account, Node.js/npm, and Tampermonkey. Open a terminal in this directory (`src/gats-community`) before running the commands below. Install/use Wrangler with `npx wrangler`.

## Before you deploy: this replaces your existing worker

`npx wrangler deploy` publishes the code and bindings from this directory over the existing `login-info-handler` worker. Anything that exists only in the Cloudflare dashboard for that worker (code edited in the dashboard, variables, the old `AUTH_KV` binding) is not kept unless it is also in `wrangler.toml`. Before the first deploy, copy the old worker's code and settings somewhere safe. The old KV namespace can be deleted later once you no longer need its data. Durable Object classes must be new: if this worker ever had classes named `Room` or `Gate`, change the class names and migration tag in `wrangler.toml` before deploying.

## First-time deployment

1. Log in to Cloudflare:

   ```bash
   npx wrangler login
   ```

2. Create the D1 database and copy the generated database ID into the `database_id` field in `wrangler.toml`. Keep the database name consistent with the file (`gats-community`).

   ```bash
   npx wrangler d1 create gats-community
   ```

3. Apply the base schema remotely:

   ```bash
   npx wrangler d1 execute gats-community --remote --file=schema.sql
   ```

4. Apply the additive rename-cooldown migration:

   ```bash
   npx wrangler d1 execute gats-community --remote --file=schema_002.sql
   ```

   Run each schema file only once against a given database. For a brand-new database, run both in order. For an existing database that already has `schema.sql` applied, apply only `schema_002.sql`. The migration adds `users.renamed_at`; do not edit an already-applied base schema instead of using the migration.

5. Set Worker secrets interactively. Generate long random values locally (for example `openssl rand -base64 48` for each; the admin key is the only thing protecting `/admin/ban`, which also throttles wrong guesses per IP); do not put these values in `wrangler.toml`, source code, chat, issues or commits.

   ```bash
   npx wrangler secret put TOKEN_SECRET
   npx wrangler secret put PEPPER
   npx wrangler secret put ADMIN_KEY
   ```

   Back up `PEPPER` securely: losing/changing it prevents stored password-derived keys from matching. Changing `TOKEN_SECRET` invalidates existing sessions. These secrets are not the same as a GitHub token.

6. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

   The configured Worker name is `login-info-handler`. Review the Wrangler output and Cloudflare dashboard to ensure you are deploying to the intended account and project.

7. Check the health endpoint in a browser or terminal:

   ```bash
   curl https://login-info-handler.gitgames.workers.dev/health
   ```

   Expected healthy response: `{"ok":true}`. If your Worker uses a different hostname, use that host instead. This health check only proves the Worker responds; it does not prove auth or the WebSocket works.

## Check the game-server hostname before relying on presence

Room names are derived from the actual gats.io game-server WebSocket host. The Worker now requires both `ROOM_REGEX` and the configured `ALLOWED_ROOM_SUFFIX`; the checked-in default is `gats.io`.

1. Open gats.io, open browser DevTools, select Network, filter WebSocket/WS, and join a game.
2. Inspect the host of the **game's own WebSocket**, not the community-presence WebSocket.
3. Confirm the host is exactly `gats.io` or a subdomain ending in `.gats.io`. If the real hosts use a different parent domain, change `ALLOWED_ROOM_SUFFIX` in `wrangler.toml` to that verified parent suffix and redeploy. Do not guess a suffix; it determines which room names clients can request.
4. The userscript sends the host to `/presence?room=...`; mismatched hosts will be rejected by the Worker.

## Install the userscript

1. Open Tampermonkey, create a new userscript, paste the complete contents of `gats-community.user.js`, and save it.
2. Confirm the header's `@connect login-info-handler.gitgames.workers.dev` and the `WORKER_URL` value near the top of the script match your deployed Worker hostname.
3. Reload gats.io, open the login badge/modal, register or log in, and then join a game.
4. Use two separate browser profiles or browsers on the same game server to test whether each sees the other's community name.

For this test, use disposable test accounts first. The current code has been syntax-checked in the relay workflow, but it has **not** been tested against the live game or a deployed Cloudflare account.

## Current routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Basic Worker health response |
| POST | `/register` | Create account; body uses `username` and derived `key` |
| POST | `/login` | Authenticate; body uses original `login` identifier and derived `key` |
| POST | `/refresh` | Refresh/validate a session token |
| POST | `/rename` | Update public display name; authenticated Bearer token required; body uses `username` and optional current `room` |
| GET | `/presence?room=...` | WebSocket upgrade; session token is passed in the WebSocket subprotocol, not the URL |
| POST | `/admin/ban` | Admin ban/unban endpoint; requires `X-Admin-Key` |

The current canonical Worker does **not** implement the donor tree's `/prelogin`, `/signup`, `/logout_all`, or `/unregister` routes. Do not follow instructions written for those donor endpoints when deploying this version.

## Admin ban/unban

Send a JSON POST to `/admin/ban` with the `X-Admin-Key` header and one of these body shapes:

```json
{"login":"originalaccount","banned":true,"reason":"abuse","rooms":["server-a.gats.io"]}
```

To unban, set `"banned": false`. The `login` field is the immutable login identifier, not the display name. Only pass room names that match the configured suffix. The endpoint can kick a banned user immediately from up to 20 named rooms; connected sockets in other rooms rely on room revalidation, so the action is not guaranteed to be instant everywhere.

Avoid putting your admin key in shell history or a shared terminal transcript.

## Security, quota and operational caveats

- Rate limiting is best-effort: see "Rate limiting and signup cap (Gate)" for the limits and residual risks (single-account lockout, many-address spraying). Nothing here has been run against a live Cloudflare account or the live game yet.
- Registration is capped per UTC day by `MAX_REG_PER_DAY` in `wrangler.toml` (default 300) to protect the D1 free write quota; see the Gate section. D1 or Durable Object quota exhaustion still makes signup/login/rename fail until 00:00 UTC. Nothing here has run on a live Cloudflare account or the live game yet, so treat it as untested until you complete the smoke-test checklist.
- Rename now has a 24-hour cooldown. The first rename after migration is allowed because existing rows get `renamed_at = 0`. Reserved display names are rejected.
- Room revalidation (bans, logout-everywhere) runs on each room alarm while a room has live sockets. `ALARM_MS` is 300,000 (5 minutes), about 288 alarms per active room per day. Each alarm is one Durable Object request against the free limit of 100,000 per day shared by everything, so many always-busy rooms can use it up; see docs/cost-estimate.md. Watch the Cloudflare usage page after your first busy day.
- Presence identity is **not cryptographic**. The client now sends the in-game username alongside its game pid and applies a community name only when it matches the local game's d-frame username. This reduces blind pid pre-claims and stale pid reuse, but a client can still claim an in-game name; the game server does not authenticate community accounts.
- The Worker does not currently provide password reset/email verification. Keep the original login identifier in a safe place.
- Do not commit Worker secrets, API tokens or account credentials.
- Back up the D1 data before schema migrations and operational changes.

## Suggested smoke-test checklist

- [ ] `GET /health` responds with `{"ok":true}`.
- [ ] Register a disposable account and confirm a token/session is stored in Tampermonkey.
- [ ] Log out and log in using the **original** account login identifier.
- [ ] Rename once, confirm the display name updates, and confirm another rename is rejected during the cooldown.
- [ ] Open two clients on the same verified game server and test join/leave/name lookup.
- [ ] Ban a disposable account and verify the user's socket is eventually closed by a room alarm.
- [ ] Inspect Cloudflare logs/usage after tests.
- [ ] Complete local automated tests and have a second reviewer inspect the security changes before calling the mission done.

## Rate limiting and signup cap (Gate)

`src/gate.js` keeps small counters in Durable Objects, one record per key, persisted so they survive eviction:

| What | Limit | Counts |
|---|---|---|
| Login failures per IP (IPv6 grouped by /64) | 20 per 15 min | failures only |
| Login failures per account | 10 per 15 min | failures only; cleared on success |
| Register per IP /64 | 5 per hour | every attempt |
| Register globally | `MAX_REG_PER_DAY` (default 300) per UTC day | every attempt; protects the D1 free write quota |
| Rename per IP /64 | 10 per hour | every attempt (plus the 24 h per-account cooldown) |

Known limits: someone can still lock a specific account for up to 15 minutes by failing 10 logins (the price of a per-account limit); an attacker with many separate IPv6 /64s or IPv4 addresses can spread attempts, and the PBKDF2 cost plus the server-side HMAC is the real defence. Gate fails open if a Gate DO errors, so an outage there cannot lock out all players. Raise `MAX_REG_PER_DAY` in `wrangler.toml` for a launch day.

Run the whole local suite with `npm test` in this directory (needs Node 20.6 or newer because the tests use `--import`; 27 tests at the time of writing). `node --test tests/gate.test.mjs` alone runs only the 5 Gate tests. These are in-process tests with a fake D1 and fake Durable Object runtime, not a real Cloudflare or workerd run.

Successful logins: the first 20 per account per hour are written to the `events` log; further ones still succeed but are not logged (keeps the D1 write quota safe). Room sweeps (stale sockets, bans, logout-everywhere) run every 5 minutes while anyone is connected, so a ban reaches a live player within about 5 minutes unless you pass `rooms` to `/admin/ban` for an instant kick.

## If presence does not work

- Open DevTools on gats.io and look for `[gcl] presence room:` in the console. That is the room name the userscript sends. It must end with your `ALLOWED_ROOM_SUFFIX`.
- After about 8 failed reconnects the userscript stops trying (to protect the free request limit) and logs `[gcl] presence gave up`. Reload the page after fixing the cause.
- Close code 4002 means the token was revoked or the account is banned, and the userscript logs you out. Code 4000 means another tab replaced this connection.
