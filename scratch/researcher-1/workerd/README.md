Repro: copy src/gats-community to a temp dir, set database_id to a dummy uuid, add .dev.vars (fake TOKEN_SECRET, PEPPER, ADMIN_KEY=canon-admin-key-1234567890),
npm i wrangler, wrangler d1 execute gats-community --local --file=schema.sql then schema_002.sql, run wrangler dev --local --port 8788 (same shell as the test,
background processes die between tool calls), then node scratch/fifth-1/tests/smoke-canonical-gats-community.mjs and gate-burst2.mjs here.
