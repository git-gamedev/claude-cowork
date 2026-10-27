# Email verification — CANONICAL design for #42 (sonnet, merged with docs/design-email-verification.md by claude-4)
Both drafts agreed on: device-based "new location", DO-held code hashes, 6-digit code/10 min/5 tries, IP /64 ban never account lock, daily mail cap. Merge picks: claude-4's single `/verify` + signed `ticket`, per-uid `Verifier` DO, `MAIL_PROVIDER`/`RESEND_API_KEY`/`MAIL_DAILY_CAP` (default 80), 10 devices/account, error key `email_busy`; sonnet's no-D1-write-before-verified registration (pending record lives in the DO; protects the D1 quota that #32 was about). If this conflicts with the other file, this file wins until #42 says otherwise.
Mission from the user: emailed random code on account creation and on login from a new location. Repeated wrong codes may cause a temporary **IP** ban, never an account lockout.

## Decisions I made (change if the user disagrees; open questions are in the [decision] issue)
1. **"New location" = unknown device, not IP.** IPs are shared/dynamic, so IP-based "new location" would nag constantly or miss real takeovers. After a successful code the userscript stores a random 128-bit `device` id (GM_setValue). Server keeps only `HMAC(device)` per account in D1 `trusted_devices` (max 10 per account, 90-day expiry, oldest dropped). Known device -> no code.
2. **Code is only sent after the password key is correct** (login) -> strangers cannot email-bomb a victim or enumerate accounts. Unknown-user and wrong-password responses stay identical (existing behaviour).
3. **Registration is two-step and writes nothing to D1 until verified.** `/register` {username,key,email,device} validates, rate-limits, stores a pending record + code hash in a Durable Object (TTL 15 min), sends the mail. `/register/verify` {challenge,code} then does the single D1 insert. Abuse costs zero D1 writes.
4. **Code**: 6 digits from `crypto.getRandomValues` (rejection sampling), stored as `HMAC(PEPPER, challenge|code)`, TTL 10 min, single use, constant-time compare, max 5 tries per code (then invalidated; a fresh code can be requested). Never logged, never in events.
5. **Failure policy**: each wrong code counts against the **IP** in Gate (`vfy:<ip /64>`): 10 wrong/hour -> 429 `ip_banned` + `retryAfter`, 1 hour (config `VERIFY_BAN_S`). The account is never locked; the real owner can still verify from another IP or after the ban. Needs the Gate TOCTOU fix (#31) to be trustworthy.
6. **Email-bomb / quota guards**: resend cooldown 60 s per challenge; per-email 5 sends/hour; per-account 10/day; per-IP 20 sends/day; global `MAIL_DAILY_CAP` (default 80; Resend free is 100/day). Over cap -> new-device logins and signups get `email_busy` (known devices keep working).
7. **Sending**: `fetch` to a transactional provider; key in wrangler secret `RESEND_API_KEY`, vars `MAIL_FROM`, `MAIL_PROVIDER=resend|none` (test stub `env.MAILER`). Cloudflare's own Email Sending is public beta but needs Workers Paid (per Cloudflare changelog 2026-04-16), so not free-tier. Resend and MailerSend advertise ~3,000/mo free (third-party comparison pages, unverified: user must confirm current limits). A **sending domain with DNS (SPF/DKIM)** is required by these providers.
8. **Existing accounts have no email**: on next login the script prompts to add + verify one (config `REQUIRE_EMAIL=false` keeps it optional during rollout).
9. Email stored lowercased in `users.email` (plaintext, needed to send) + `email_verified_at`; unique index on `email_hash`. Not in events, not in presence frames, not returned by lookups.

## API contract (userscript <-> worker)
`ticket` = HMAC-signed 10-min token (purpose, uid or pending-username, devhash); `/verify` never re-sends the password.
- `POST /register` {username,key,email,device} -> 202 `{verify:"code",ticket,hint:"j***@x.com",expiresIn,resendIn}`; pending record + code hash live in the Verifier DO, **0 D1 writes**. Errors: 400 invalid_input | 409 name_taken/email_taken | 429 rate_limited/ip_banned `{retryAfter}` | 503 email_busy
- `POST /login` {username,key,device} -> 200 session (known device, verified email) | 202 `{verify:"code",ticket,hint}` (new device; code sent) | 202 `{verify:"email_needed",ticket}` (legacy account) | existing errors
- `POST /email` {ticket,email} -> 202 `{verify:"code",ticket,hint}` (legacy accounts add an address)
- `POST /verify` {ticket,code,device} -> 200 session (register: single D1 insert; login: device trusted) | 400 bad_code `{triesLeft}` | 410 code_expired | 429 ip_banned `{retryAfter}`
- `POST /resend` {ticket} -> 200 `{resendIn}` | 429 `{retryAfter}`
Banned accounts (`banned`) never get a code. Every new error key must be added to the userscript ERRORS map (the #41 lesson).

## Schema (schema_003.sql)
`ALTER TABLE users ADD COLUMN email TEXT; ADD COLUMN email_hash TEXT; ADD COLUMN email_verified_at INTEGER;` unique index on `email_hash`. `CREATE TABLE trusted_devices(user_id, dev_hash, created_at, last_seen, PRIMARY KEY(user_id,dev_hash))`. Writes: one row on verify only.

## Tests required (mock `fetch` for the provider)
code format/expiry/single-use/max-tries; wrong codes ban the IP but not the account (other IP still logs in); resend cooldown; per-email and global caps; known device skips code; banned user gets no mail; no code or email in logs/events; concurrent verify of one code succeeds once; pending register writes 0 D1 rows.

## Not covered
Real mail delivery (needs user's domain + provider key), browser UI run, email change flow polish, Turnstile.
