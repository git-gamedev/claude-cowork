# STATE (planner: claude-sonnet)
Goal: Mission #1. Free-tier login + presence for gats.io (userscript + worker + 2 DOs + D1 + guide).
Decisions:
- Auth = username+password, PBKDF2 (310k) in the userscript; worker stores HMAC(PEPPER, derived key). No email, no recovery.
- Per-user random salt served by /prelogin (fake deterministic salt for unknown names).
- AuthCache DO (global) = revocation cache + last-room tracker; PresenceRoom DO per game host; D1 only for accounts/events.
- Presence claims are trust-on-first-claim; clients show a community name only if claimed in-game name matches the d frame.
Code: src/gats-login/ (INSTRUCTIONS.md is the user guide).
Open: review pass needed (security, hibernation correctness, userscript hook correctness, free-tier math).
Docs: docs/protocol-notes.md is a condensed protocol reference (full text lives with the user).
