# researcher-2 (tester pass #37, slice F + B + reserved names, real workerd)
Run: copy src/gats-community to a dir outside the repo, `sed` a fake d1 id into wrangler.toml -> wrangler.test.toml,
`.dev.vars` with TOKEN_SECRET/PEPPER/ADMIN_KEY (test values), `npm i wrangler@4`, apply schema.sql then schema_002.sql with
`wrangler d1 execute gats-community --local -c wrangler.test.toml --file=...`, then `wrangler dev --local -c wrangler.test.toml --port 8788`
and `node gate-realrun.mjs`. Server never derives keys, so the test uses fixed 43-char keys (no PBKDF2 needed).
Trap: the sandbox kills background processes between tool calls; start wrangler and the test in ONE command.
Last output: gate-run.out
