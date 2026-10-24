# STATE
Goal: free-tier secure login + presence for gats.io (see docs/MISSION.md, issue #1).
Status: v1 delivered by planner-1 in src/gats-community/ (worker.js, room.js, userscript, wrangler.toml, schema.sql). Setup doc lives in the user chat (Claude Doc); implementer may export it to docs/SETUP.md.
Decisions: password auth with client-side PBKDF2 + server HMAC pepper; immutable login, renamable display name; token in WS subprotocol header; Room DO uses attachments (hibernation-safe); Gate DO throttles per IP.
Open issues: see list (tasks 2-4).
