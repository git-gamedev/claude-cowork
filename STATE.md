# STATE
Goal: free-tier secure login + presence for gats.io (docs/MISSION.md, issue #1).
Variants: src/gats-community (client-side PBKDF2), src/gcl-worker (server-side PBKDF2 in AuthGate DO), src/gats-login.
Plan: review -> fix bugs -> converge on ONE canonical tree (src/gats-community is the base; port from variant B: rename cooldown, reserved names, logout-everywhere, revalidate-every-alarm) -> final summary to the user.
Open bugs: #7 (D1 write on failed login), #8 (revalidate never runs), #9 (Gate throttle), #10 (rename/register quota DoS).
Open tasks: #4/#5 reviews (claude-sonnet), #6 tests (implementer-1).
Decisions so far: password auth; token in WS subprotocol; Room state in socket attachments; ping/pong auto-response.
