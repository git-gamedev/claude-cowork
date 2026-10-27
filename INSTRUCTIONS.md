# gats.io Community Login: setup guide

Free-tier login and live name display for gats.io. Players get a community account; other players with the script see their community name in game.

## What is in this repo

| Part | Where | What it does |
|---|---|---|
| 1. Client script | `userscript/gats-community.user.js` | Tampermonkey script: login/register UI, hooks the game's WebSocket, shows community names. Keeps the session token in Tampermonkey storage (page scripts cannot read it). |
| 2. Worker | `worker/src/worker.js` | The in-between Cloudflare Worker: `/register`, `/login`, `/refresh`, `/rename`, `/verify`, `/resend`, `/email`, `/admin/ban`, `/health`, and the `/presence` WebSocket. Signs tokens, talks to D1. |
| 3. Durable Objects | `worker/src/room.js`, `gate.js`, `verifier.js` | `Room`: presence for one game server (hibernating sockets). `Gate`: rate-limit counters. `Verifier`: pending email codes (only used if email verification is on). |
| 4. This guide | `INSTRUCTIONS.md` | Setup and operation. |

Also in `worker/`: `schema.sql`, `schema_002.sql`, `schema_003.sql` (D1 tables, apply in order), `wrangler.toml` (config), `tests/` (local tests).

## How it works, briefly

- The script stretches the password in the browser (PBKDF2-SHA-256, 600,000 rounds, salted with the lowercase login) and sends only the derived key. The Worker HMACs it with `PEPPER` and stores that.
- `login` is the permanent lowercase account id; `username` is the changeable display name (24 h rename cooldown). Remember the original login.
- After login the script opens one WebSocket to `/presence` for the game server it is on. A community name is shown only when the claimed in-game name matches the game's own name for that player. This is not authentication: the game server does not know about community accounts.

## Before you start

You need a Cloudflare account (free plan is fine), Node.js 20.6 or newer, and Tampermonkey. Run all commands from the `worker/` folder.

**This replaces your existing `login-info-handler` worker.** `wrangler deploy` overwrites it. Copy the old worker's code and settings somewhere safe first (anything that only lives in the dashboard, including the old KV binding, is not kept).

## Deploy

1. `npx wrangler login`
2. `npx wrangler d1 create gats-community`, then paste the printed `database_id` into `worker/wrangler.toml`.
3. Apply the schemas once each, in order:
   ```bash
   npx wrangler d1 execute gats-community --remote --file=schema.sql
   npx wrangler d1 execute gats-community --remote --file=schema_002.sql
   npx wrangler d1 execute gats-community --remote --file=schema_003.sql
   ```
   (An existing database that already has `schema.sql` needs only the later files it is missing.)
4. Set three secrets. Use long random values (for example `openssl rand -base64 48`) and never put them in files, chat or git:
   ```bash
   npx wrangler secret put TOKEN_SECRET
   npx wrangler secret put PEPPER
   npx wrangler secret put ADMIN_KEY
   ```
   Back up `PEPPER`: if it changes, nobody's password matches any more. Changing `TOKEN_SECRET` logs everyone out.
5. Check the game hostnames (next section), then `npx wrangler deploy`.
6. `curl https://login-info-handler.gitgames.workers.dev/health` should return `{"ok":true}` (use your own worker URL if different).

### Check the game-server hostname (do this before relying on presence)

The Worker only accepts rooms whose host ends in `ALLOWED_ROOM_SUFFIX` (default `gats.io`, which is a guess).

1. Open gats.io, DevTools, Network, filter WS, join a game.
2. Look at the host of the **game's own** WebSocket.
3. If it is not `gats.io` or `*.gats.io`, set `ALLOWED_ROOM_SUFFIX` in `wrangler.toml` to the real parent domain and redeploy.

## Install the userscript

1. In Tampermonkey create a new script, paste all of `userscript/gats-community.user.js`, save.
2. If your Worker URL differs from `login-info-handler.gitgames.workers.dev`, change both the `@connect` line in the header and `WORKER_URL` near the top.
3. Reload gats.io, use the login badge to register, then join a game.
4. Test with two browsers (or profiles) on the same game server: each should see the other's community name. Use disposable accounts.

## Optional: email verification (off by default)

With `EMAIL_VERIFY = "on"` the Worker emails a 6-digit code when an account is created and when someone logs in from a browser it has not verified before ("new device" means a Tampermonkey storage without a trusted device id, not a new network). Existing accounts are asked to add an email at their next login. Wrong codes: 5 tries per code, and 10 wrong codes per hour from one network (IPv6 per /64) bans that network from register, login and verify for the rest of the hour. The account itself is never locked.

Setup:
1. Pick a provider. The Worker has a Resend adapter (free plan about 100 emails/day; you must verify a sending domain you own). Cloudflare's own sending needs the paid plan.
2. Make sure `schema_003.sql` is applied.
3. `npx wrangler secret put RESEND_API_KEY` (a send-only key).
4. In `wrangler.toml` set `MAIL_FROM` to an address on your verified domain, keep `MAIL_DAILY_CAP` under your provider's daily limit (default 80), set `EMAIL_VERIFY = "on"`, redeploy.
5. Every player needs the current userscript; an old one cannot answer the code prompt.

Known limit: when the daily email cap is used up, new sign-ups and new-device logins get `email_busy` until 00:00 UTC (known devices keep working), and someone can use the cap up with cheap sign-ups (open issue #48). Not built: changing or removing an email, "log out other devices".

## Admin: ban and unban

```bash
curl -X POST https://YOUR-WORKER/admin/ban -H "X-Admin-Key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"login":"originalaccount","banned":true,"reason":"abuse","rooms":["server-a.gats.io"]}'
```

Use `"banned": false` to unban. `login` is the immutable login, not the display name. Naming up to 20 `rooms` kicks the player immediately; otherwise a live socket is closed by the room sweep within about 5 minutes. Wrong admin keys are throttled per IP.

## Limits and caveats

- Rate limits (Gate): 20 failed logins per IP per 15 min, 10 per account per 15 min, 5 registrations per IP per hour, 10 renames per IP per hour, `MAX_REG_PER_DAY` (default 300) new accounts per UTC day. Someone can lock one account for up to 15 minutes by failing 10 logins. Gate fails open if it errors.
- Free-plan quotas: D1 about 100,000 row writes/day, Durable Objects 100,000 requests/day. Each active room costs about 288 sweep requests/day (`ALARM_MS` = 5 min). Check the Cloudflare usage page after your first busy day. If a quota runs out, register/login/rename fail until 00:00 UTC.
- Reserved display names (admin, staff, and look-alikes) are rejected.
- Never commit secrets or tokens. Back up D1 before migrations.

## Smoke test checklist

- [ ] `/health` returns `{"ok":true}`
- [ ] Register a disposable account; log out; log in with the **original login**
- [ ] Rename once; a second rename is refused during the cooldown
- [ ] Two browsers on one game server see each other's community names
- [ ] Ban a disposable account; its socket closes (instantly with `rooms`, else within about 5 minutes)
- [ ] If email is on: register gets a code; relogin on the same browser needs none; a fresh browser needs one
- [ ] `npx wrangler tail` shows no passwords, tokens, emails or codes

## Troubleshooting presence

- DevTools console on gats.io: `[gcl] presence room: <host>`. That host must end with `ALLOWED_ROOM_SUFFIX`.
- After about 8 failed reconnects the script stops (to save quota) and logs `[gcl] presence gave up`; reload the page after fixing the cause.
- Close code 4002 = token revoked or account banned (script logs out). 4000 = another tab replaced this connection. 4001 = heartbeat timeout.

## Tests

- `cd worker && npm test`: 48 local tests with a fake D1 and fake Durable Objects (Node 20.6+).
- `node userscript/replay.mjs`: replays synthetic game frames through the userscript's frame logic (9 checks).
- Verified so far: these, plus a local workerd run (`wrangler dev --local`) of register, login, presence, ban, rate limits and email verification with a fake mailer. **Not yet verified:** a real Cloudflare deploy, a real browser with Tampermonkey on gats.io, the live game, and real email delivery. Treat the first deploy as a test.
