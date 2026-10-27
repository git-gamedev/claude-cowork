# Email verification — design (sonnet, draft for planner/user review)
Mission from the user: emailed random code on account creation and on login from a new location. Repeated wrong codes may cause a temporary **IP** ban, never an account lockout.

## Decisions I made (change if the user disagrees; open questions are in the [decision] issue)
1. **"New location" = unknown device, not IP.** IPs are shared/dynamic, so IP-based "new location" would nag constantly or miss real takeovers. After a successful code the userscript stores a random 128-bit `device` id (GM_setValue). Server keeps only `HMAC(device)` per account in D1 `trusted_devices` (max 5 per account, 90-day expiry, LRU). Known device -> no code.
2. **Code is only sent after the password key is correct** (login) -> strangers cannot email-bomb a victim or enumerate accounts. Unknown-user and wrong-password responses stay identical (existing behaviour).
3. **Registration is two-step and writes nothing to D1 until verified.** `/register/start` {username,key,email,device} validates, rate-limits, stores a pending record + code hash in a Durable Object (TTL 15 min), sends the mail. `/register/verify` {challenge,code} then does the single D1 insert. Abuse costs zero D1 writes.
4. **Code**: 6 digits from `crypto.getRandomValues` (rejection sampling), stored as `HMAC(PEPPER, challenge|code)`, TTL 10 min, single use, constant-time compare, max 5 tries per code (then invalidated; a fresh code can be requested). Never logged, never in events.
5. **Failure policy**: each wrong code counts against the **IP** in Gate (`vfy:<ip /64>`): 10 wrong/hour -> 429 `ip_banned` + `retryAfter`, 1 hour (config `VERIFY_BAN_S`). The account is never locked; the real owner can still verify from another IP or after the ban. Needs the Gate TOCTOU fix (#31) to be trustworthy.
6. **Email-bomb / quota guards**: resend cooldown 60 s per challenge; per-email 5 sends/hour; per-account 10/day; per-IP 20 sends/day; global `MAX_EMAILS_PER_DAY` (default 90, matches a 100/day free plan). Over cap -> new-device logins get `email_unavailable` (known devices keep working).
7. **Sending**: `fetch` to a transactional provider; key in wrangler secret `EMAIL_API_KEY`, vars `EMAIL_FROM`, `EMAIL_PROVIDER=resend|mailersend`. Cloudflare's own Email Sending is public beta but needs Workers Paid (per Cloudflare changelog 2026-04-16), so not free-tier. Resend and MailerSend advertise ~3,000/mo free (third-party comparison pages, unverified: user must confirm current limits). A **sending domain with DNS (SPF/DKIM)** is required by these providers.
8. **Existing accounts have no email**: on next login the script prompts to add + verify one (config `REQUIRE_EMAIL=false` keeps it optional during rollout).
9. Email stored lowercased in `users.email` (plaintext, needed to send) + `email_verified_at`; unique index on `email_hash`. Not in events, not in presence frames, not returned by lookups.

## API contract (userscript <-> worker)
- `POST /register/start` -> 200 `{challenge, expiresIn, resendIn}` | 400 invalid_input | 409 name_taken/email_taken | 429 rate_limited/ip_banned `{retryAfter}` | 503 email_unavailable
- `POST /register/verify` {challenge, code} -> 200 session (same shape as /register today) | 400 bad_code `{triesLeft}` | 410 code_expired | 429 ip_banned
- `POST /login` {username,key,device} -> 200 session (known device) | 202 `{challenge, expiresIn, resendIn}` (new device; code sent) | existing errors
- `POST /login/verify` {challenge, code, device} -> 200 session (device trusted) | same errors as register/verify
- `POST /email/resend` {challenge} -> 200 `{resendIn}` | 429 `{retryAfter}`
- `POST /account/email` (token) {email} -> 202 `{challenge}`; `/email/verify` completes it (for existing accounts).
Banned accounts (`banned`) never get a code. All new error keys must be added to the userscript ERRORS map (see #41 lesson).

## Schema (schema_003.sql)
`ALTER TABLE users ADD COLUMN email TEXT; ADD COLUMN email_hash TEXT; ADD COLUMN email_verified_at INTEGER;` unique index on `email_hash`. `CREATE TABLE trusted_devices(user_id, dev_hash, created_at, last_seen, PRIMARY KEY(user_id,dev_hash))`. Writes: one row on verify only.

## Tests required (mock `fetch` for the provider)
code format/expiry/single-use/max-tries; wrong codes ban the IP but not the account (other IP still logs in); resend cooldown; per-email and global caps; known device skips code; banned user gets no mail; no code or email in logs/events; concurrent verify of one code succeeds once; pending register writes 0 D1 rows.

## Not covered
Real mail delivery (needs user's domain + provider key), browser UI run, email change flow polish, Turnstile.
