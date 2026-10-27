# researcher-1: email verification (#45 slice 4) in real workerd
Run: wrangler 4.153 dev --local (workerd, local D1, real DO), src/gats-community copied at b80ec1b, EMAIL_VERIFY=on. Mail provider replaced by a TEST-ONLY wrapper (scratch/researcher-1/email/e2e-entry.js, sets env.MAILER and exposes /__mails). Not run: real Resend, real Cloudflare, browser.
Scripts and raw output: scratch/researcher-1/email/ (e2e-email.mjs, ipban.mjs, *.out). Needs two server starts: EMAIL_VERIFY off to create a legacy account, then on.

## Passed
- register without/invalid email 400; register -> 202 verify with masked hint; wrong code 401 left 4; bad format 400; correct code -> session.
- known device logs in with no code; new device -> 202 device -> verify -> known afterwards; duplicate email (case-insensitive) 409 email_taken.
- legacy account (created with EMAIL_VERIFY off) -> 202 email_needed -> /email -> verify -> session.
- Brute force bounded: one code dies after 5 wrong tries (parallel x30 from 30 IPs: 4x401 then 410). Parallel x40 from one IP: 4x401, 6x410, 30x429 ip_banned.
- IP ban: 10 counted wrong codes (two codes x5) -> 429 ip_banned on /verify, /login (even correct pw, known device) and /register from that IP; same account still logs in from another IP (no account lockout).

## Findings
1. Global mail cap is an availability lever (MEDIUM). With MAIL_DAILY_CAP=16, 10 registrations from distinct IPs (any addresses, nothing verified) exhausted it; afterwards new registrations and new-device logins return 503 email_busy for everyone until UTC midnight (known-device logins unaffected). Default cap 80 = 80 cheap registrations (limit 5 per IP/hour). Suggest: reserve part of the cap for logins on existing accounts, cap registration mails separately (e.g. half), consider Turnstile on /register.
2. Register mails arbitrary third-party addresses (per IP 5/h, per account cooldown 60 s): low-volume email bombing/spam via your sending domain. Same mitigations.
3. Minor: a code only counts toward the IP ban while live. After the 5th wrong try (dead) further /verify calls return 410 code_expired and are NOT counted, so one ticket can never reach the 10-failure ban; it takes two codes (resend, 60 s cooldown). Fine as designed, but INSTRUCTIONS/design should not promise ban after 10 wrong submissions.
4. Minor: in a parallel burst, /try slot reservations return ip_banned to requests that never failed (30 of 40 above), so legit users behind the same IP can see a brief ip_banned during someone elses burst.
5. UX: logging in within 60 s of registering returns 429 resend_cooldown (new device with no dev id does the same); userscript has a message for it.
