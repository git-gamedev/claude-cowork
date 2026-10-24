# Critic review of src/gats-community (v1) by claude-sonnet

Commit reviewed: 187415c. Nothing here was run against Cloudflare or the live game; findings come from reading code against docs/protocol-notes.md.

## High / medium
1. **Presence claims are unverifiable (room.js:93 hello, user.js:511 applyName).** hello carries only a pid. Any account can claim any pid first and wear the victim name tag for everyone. Fix: client sends gname (the in-game username from the a frame, field 18); room stores and rebroadcasts it; receivers apply a community name only if gname equals the d-frame username (src/gats-login does this, see nameFor()).
2. **Phantom players from b/c frames (user.js:530, 535).**  creates entries for ids never introduced by a d frame, and after an e frame a late b/c re-creates one. applyName then calls rebuildPlayer on a stub with blank classCode/username/teamCode and injects a d frame, which can create a ghost player in the game client. Fix: in b/c, . Only d creates a ghost.
3. **Alarm every 60 s keeps rooms awake (room.js:9,53,140).** Each alarm is a billed DO request and a wake: ~1440/day per occupied room. Many servers x 1440 eats the 100k/day free DO request budget with no gameplay at all. Fix: sweep lazily (on hello/join) or alarm every 5 min and fold revalidation into it.
4. **Room names are attacker-chosen (worker.js:178,203,221).** Regex ^[a-z0-9.:-]{1,64}$ lets any account mint unlimited Room objects. Fix: require host === suffix or endsWith(.suffix) via a var, as in src/gats-login/src/index.js presence().
5. **No per-account throttle.** Gate (room.js:188) is per IP, so a botnet can guess one password forever. Fix: failed_count/locked_until on users (see src/gats-login verifyPassword()), 8 failures -> 10 min, write only on failure.
6. **Gate cost.** Every login/register/rename adds a DO request; sign-ups allow 10 per 10 min per IP = 1440 accounts/day per IP. Fix: cap sign-ups per IP per hour from events (one indexed read), keep Gate for login.

## Low
7. a frame swap sets p[18] only (user.js:562). protocol notes list field 23 isolatedUsername; if it equals the old name, set it too. Guard p.length > 18.
8. LAZY_IDS survives a frames and room churn (user.js:523): stale pid->name can mislabel a new player. Tie entries to the claimed gname (finding 1) or clear on a.
9. No /unregister or /logout_all endpoint; skeleton lists apiUnregister.
10. rename has no cooldown (worker.js:169): name churn + a D1 write per call. Add renamed_at and 24 h.
11. Origin check (worker.js:194) may reject a userscript socket in some browsers; harmless to keep but do not rely on it as security.
12. Ban kick only reaches rooms the admin lists (worker.js:221); others wait up to 5 min. A uid->last-room record (src/gats-login AuthCache) makes it instant.

## What is good (keep)
Token in the subprotocol, rename revocation inside the UPDATE (zero reads), attachment-based hibernation state, constant-time verify via subtle.verify, auto-response ping.
