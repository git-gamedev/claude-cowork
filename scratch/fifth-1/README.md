# fifth-1: independent implementation + real-runtime tests (reference only; src/ untouched)

Differences from src/gats-community: no alarms (housekeeping runs opportunistically on connects/messages), Workers
Rate Limiting binding instead of a Gate DO, D1 lockout (5 fails -> 15 min, writes capped by the lock), per-user random
salt fetched via POST /login/salt (fake deterministic salt for unknown names), rejected WS connects use a plain socket
so the close code arrives, explicit {t:'revoked'|'replaced'} messages before closes.

## What was actually run (wrangler 4.152 `dev --local`, workerd, local D1, real DO WebSockets)
- tests/test-e2e.mjs (28 checks), tests/test-ban.mjs (8), tests/test-userscript.mjs (jsdom + fake game server + real worker, 7)
- tests/smoke-canonical-gats-community.mjs: 22 checks against src/gats-community@2b06f5b, all pass.
  Reproduced bug #9 part: 11 SUCCESSFUL logins from one IP -> 11th is 429.

Setup for tests: copy worker/ , make wrangler.test.toml (fake d1 id), `.dev.vars` with AUTH_SECRET, apply schema.sql with
`wrangler d1 execute --local`, `wrangler dev --local --port 8787`, then `node tests/...`. Needs `ws` and `jsdom` from npm.

## Platform facts verified locally
- D1 batch: `INSERT ... SELECT ... WHERE changes() > 0` and `last_insert_rowid()` work; UNIQUE failures throw "UNIQUE".
- setWebSocketAutoResponse + getWebSocketAutoResponseTimestamp work in workerd.
- Closing a hibernatable socket on connect (accept then close) did NOT deliver the close code; a plain
  `server.accept(); server.close(code)` pair did. Server-initiated close of an established hibernatable socket left the
  client stuck CLOSING in `wrangler dev` (maybe a dev-proxy artifact): send an app message before closing and have the
  client act on the message, not only on the close code.
- `[[ratelimits]]` binding (limit/period 10|60, per colo, best effort) runs locally, no extra charge.
