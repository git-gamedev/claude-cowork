# Email verification (mission from the user, 2026-10-26) — design, claude-4

## Requirements (user)
- Script sends a random code to an email address; user types it in (a) when creating an account, (b) when logging in from a new location.
- Repeated wrong codes may IP-ban temporarily. NEVER lock the account.

## Provider (researched 2026-10-26; limits change, verify before deploy)
- Cloudflare Email Sending (public beta, Apr 2026) needs Workers PAID. Not free-tier.
- Resend free: 3,000/mo, **100/day**, 1 verified domain (user needs a domain + DNS records). REST call from the Worker, key as secret RESEND_API_KEY.
- So email is a scarce budget: global daily cap MAIL_DAILY_CAP (default 80) enforced in Gate; per-IP, per-account and per-address send limits. When the cap is hit, registration/new-device login return `email_busy` (known DoS-of-signups trade-off, bounded by the per-IP limits).
- Mailer is pluggable (`MAIL_PROVIDER=resend|none`, `env.MAILER` stub in tests).

## Decisions
1. **New location = new DEVICE**, not new IP (mobile/IPv6 IPs churn). Userscript keeps a random 128-bit `dev` id in GM storage; server stores only HMAC(PEPPER, uid|dev) in `devices` after a successful code. Missing/unknown dev => code required. Max 10 devices per account (oldest dropped). OPEN QUESTION for user: also trigger on country change (request.cf.country)?
2. **Register** creates the user row as today plus `email` (unverified) and sends a code. Login is refused (`verify_required`) until verified. Unverified rows older than 1 h are replaced lazily if their name is requested again (no cron).
3. **Login**: password check unchanged (client PBKDF2, Gate /try, /fail, /ok). On success, if email unverified or device unknown: NO session; return `{verify:"code", purpose, hint:"j***@x.com", ticket}` and send a code. `ticket` = HMAC-signed 10-minute token (uid, purpose, devhash), so /verify never re-sends the password.
4. **POST /verify {ticket, code}**: success => set email_verified_at (if needed), insert device, log event, return the normal session. Wrong code => counts against (a) the code (5 tries, then dead, user must resend) and (b) the IP /64: 10 wrong per hour => IP banned from /login /register /verify /resend until the window ends. Account is never locked: password login still works from other IPs and a fresh code can be requested.
5. **POST /resend {ticket}**: 60 s cooldown per account, 5 sends/hour per account, 10 sends/hour per IP, plus the global daily cap.
6. **Existing accounts without email**: login with password returns `{verify:"email_needed", ticket}`; client calls POST /email {ticket,email}; then the normal code step.
7. **Code**: 6 digits, uniform (rejection sampling on getRandomValues), stored as HMAC(PEPPER, "code|uid|code") in a new SQLite-backed DO `Verifier` (one per uid), TTL 10 min, constant-time compare. Guess odds per code: 5 tries / 1e6; per IP: 10 tries/hour.
8. **D1 writes**: only on verified success (email_verified_at, device row, event) and register. Codes/attempt counters live in the DO.
9. Email unique per account (partial unique index). Known leak: `email_taken` reveals an address is registered; accepted, documented.
10. Email change / removal is out of scope (needs its own flow).

## Schema: schema_003.sql (apply once after 002). New DO class needs wrangler migration v2 (Verifier).
## Not verified: real Resend delivery, real workerd, browser UI. Node fake D1/DO tests only.
