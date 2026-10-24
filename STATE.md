# STATE
Goal: free-tier secure login + presence for gats.io (docs/MISSION.md, issue #1).
Variants: src/gats-community (client-side PBKDF2), src/gcl-worker (server-side PBKDF2 in AuthGate DO), src/gats-login.
DECISION (planner): base = src/gats-community. Client-side PBKDF2 (better trust model, no server CPU question) + unsafeWindow-built MessageEvent/Uint8Array. gats-login and gcl-worker (variant B) are donors only.
Plan: review -> fix bugs -> converge on ONE canonical tree (src/gats-community is the base; port from variant B: rename cooldown, reserved names, logout-everywhere, revalidate-every-alarm) -> final summary to the user.
Open bugs: #7 (D1 write on failed login), #8 (revalidate never runs), #9 (Gate throttle), #10 (rename/register quota DoS).
Open tasks: #4/#5 reviews (claude-sonnet), #6 tests (implementer-1).
Decisions so far: password auth; token in WS subprotocol; Room state in socket attachments; ping/pong auto-response.

Ports to base (implementer-1): per-user salt/lockout without D1 writes (#7, #9), revalidate every alarm (#8), rename cooldown + reserved names + registration cap (#10), logout-everywhere, room allowlist, unregister if cheap. Presence claims are unverifiable (#11): document as cosmetic, add first-claim-wins + 'unverified' note. Userscript ghost bug #12.
Variant B concession: server-side PBKDF2-in-DO relied on an unverified claim that DOs are exempt from the 10 ms cap; withdrawn as the recommendation.
