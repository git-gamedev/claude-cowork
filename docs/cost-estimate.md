# Free-tier cost estimate: Room alarm + revalidation (claude-1, 2026-10-24)

Limits (Workers Free, checked against developers.cloudflare.com pricing pages 2026-10-24; reset 00:00 UTC; exceeding any one makes that operation fail):
- Workers: 100,000 requests/day, 10 ms CPU/request
- Durable Objects: 100,000 requests/day, 13,000 GB-s/day, SQLite-backed only
- D1: 5,000,000 rows read/day, 100,000 rows written/day
- WebSocket incoming messages bill 20:1 as DO requests; alarm invocations count as requests.

Code under review: src/gats-community/src/room.js, ALARM_MS = 60_000, alarm() calls revalidate(live) every tick while any socket is open.

## Math
- Alarms: 1,440/day per room that has >=1 socket all day = 1,440 DO requests.
- Rows read: one PK lookup per distinct connected uid per tick = 1,440 x N rows/day/room (chunks of 80 uids = ceil(N/80) D1 queries per tick).
- Rows written: 0 from revalidation (good).
- Duration: alarm work is a few ms; idle sockets hibernate, so GB-s is negligible. 13,000 GB-s at 128 MB is about 104,000 active seconds/day.

## What actually breaks first
1. DO requests, not D1: 100,000 / 1,440 = about 69 rooms with continuous presence use up the whole DO daily budget on alarms alone, before any connects or messages. gats.io has many servers, so this is plausible.
2. D1 rows read: 5M / 1,440 = about 3,470 concurrent connected users all day. Not a near-term limit.
3. Heartbeats: if the client sends one every 30 s, that is 2,880 messages/user/day = 144 DO requests/user/day at 20:1 (unless the ping auto-response is not billed; unverified, test with wrangler tail/dashboard). 300 always-on users = 43k/day.

## Recommendation
- Raise ALARM_MS to 300_000 (288 alarms/day/room, about 5x fewer) or revalidate only every 5th alarm while keeping the 60 s idle-timeout sweep. Ban latency becomes up to about 5 minutes, which is fine for a game.
- Skip the alarm entirely for rooms with 0 sockets (already done: no reschedule when live is empty).
- Keep one cheap check on connect (already done via userRec) so banned users cannot rejoin.
- Document the 69-room ceiling and the fail-until-00:00-UTC behavior in INSTRUCTIONS.md.

Not verified: whether auto-response pings are billed; real room count of gats.io.
