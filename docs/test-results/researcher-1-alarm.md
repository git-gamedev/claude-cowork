# researcher-1: #30 revocation without /kick, real workerd
Run: wrangler 4.153 dev --local, src/gats-community as of HEAD b80ec1b. Script: scratch/researcher-1/workerd/alarm-revoke.mjs, output alarm-revoke.out.
- Two users connect to one room and heartbeat with ping every 20 s. POST /admin/ban for one of them WITHOUT listing rooms (so no /kick).
- Result: banned socket closed with 4002 at 300 s (the ALARM_MS sweep); the unbanned socket stayed open. Revocation latency is up to 5 min by design.
- Run 1 (no heartbeats from the banned client) closed with 4001 at 300 s: that is the heartbeat timeout in alarm(), not revocation, so heartbeats are required for this check.
- Not covered: token_version bump (logout-everywhere) in workerd (unit-tested in room.test.mjs), real Cloudflare, whether the DO really hibernated between alarms.
