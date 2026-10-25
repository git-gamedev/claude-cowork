// Tester pass (researcher-1): simulate a day of traffic against the canonical worker and count what the free plan meters.
// Run from scratch/researcher-1:
//   node --no-warnings --import ../../src/gats-community/tests/register.mjs quota-sim.mjs
// D1 "rows written" is ESTIMATED from the schema: each INSERT/UPDATE = 1 table row + 1 per index touched.
import { makeEnv, call, key } from "../../src/gats-community/tests/harness.mjs";

const LIMITS = { workerReq: 100_000, doReq: 100_000, d1Rows: 100_000, doRows: 100_000 };
const INDEX_ROWS = { 'INSERT INTO users': 4, 'INSERT INTO events': 2, 'UPDATE users SET username': 2, 'UPDATE users SET banned': 1 };

function instrument(env) {
  const c = { workerReq: 0, doReq: 0, d1Rows: 0, doRows: 0, d1Reads: 0 };
  const dbPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    const st = dbPrepare(sql);
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
    const w = Object.entries(INDEX_ROWS).find(([k]) => sql.includes(k));
    const rows = isWrite ? 1 + (w ? w[1] : 1) : 0;
    const wrap = (s) => ({ ...s, bind: (...a) => wrap(s.bind(...a)),
      async run() { c.d1Rows += rows; return s.run(); },
      async first() { c.d1Reads++; return s.first(); }, async all() { c.d1Reads++; return s.all(); } });
    return wrap(st);
  };
  const dbBatch = env.DB.batch;
  env.DB.batch = (list) => { c.d1Rows += 4 + 2; return dbBatch(list); }; // register: users(1+3) + events(1+1)
  const gateGet = env.GATE.get;
  env.GATE.get = (n) => { const g = gateGet(n); return { fetch: (u) => { c.doReq++; if (/\/(hit|fail)\?/.test(u)) c.doRows += 2; return g.fetch(u); } }; };
  return c;
}
const worker = async (env, c, ...a) => { c.workerReq++; return call(env, ...a); };
const row = (label, c) => {
  const pct = (v, l) => `${v}`.padStart(7) + ` (${((100 * v) / l).toFixed(0)}%)`;
  console.log(`${label.padEnd(28)} worker ${pct(c.workerReq, LIMITS.workerReq)}  DO req ${pct(c.doReq, LIMITS.doReq)}  D1 rows ${pct(c.d1Rows, LIMITS.d1Rows)}  DO rows ${pct(c.doRows, LIMITS.doRows)}`);
};

// ---- Scenario A: normal day. U registered players; each logs in L times; 10% rename; 2% mistype a password once ----
for (const [U, L] of [[100, 2], [300, 3], [1000, 3]]) {
  const env = makeEnv({ MAX_REG_PER_DAY: String(U) }); const c = instrument(env);
  let ok = 0, blocked = 0;
  for (let i = 0; i < U; i++) {
    const ip = `10.${(i >> 8) & 255}.${i & 255}.1`, name = `Play${i}`;
    const r = await worker(env, c, "/register", { body: { username: name, key: key("a") }, ip });
    if (r.status !== 200) { blocked++; continue; }
    ok++;
    let tok = r.json.token;
    if (i % 50 === 0) await worker(env, c, "/login", { body: { login: name.toLowerCase(), key: key("z") }, ip }); // typo
    for (let j = 0; j < L; j++) { const l = await worker(env, c, "/login", { body: { login: name.toLowerCase(), key: key("a") }, ip }); tok = l.json.token; }
    if (i % 10 === 0) await worker(env, c, "/rename", { token: tok, body: { username: name + "x" }, ip });
  }
  row(`A: ${U} players x ${L} logins`, c);
  if (blocked) console.log(`   (${blocked} registrations refused: daily signup cap)`);
}

// ---- Scenario B: attacker sprays random usernames from 200 IPs (unknown accounts) ----
{
  const env = makeEnv(); const c = instrument(env); let limited = 0;
  for (let i = 0; i < 5000; i++) {
    const r = await worker(env, c, "/login", { body: { login: "rnd" + i, key: key("q") }, ip: `203.0.${i % 200}.7` });
    if (r.status === 429) limited++;
  }
  row("B: 5000 spray, unknown names", c); console.log(`   rate_limited responses: ${limited}`);
}

// ---- Scenario C: attacker hammers ONE known account from one IP ----
{
  const env = makeEnv(); const c = instrument(env);
  await worker(env, c, "/register", { body: { username: "Victim", key: key("v") }, ip: "1.1.1.1" });
  const before = { ...c }; let limited = 0;
  for (let i = 0; i < 2000; i++) { const r = await worker(env, c, "/login", { body: { login: "victim", key: key("w") }, ip: "6.6.6.6" }); if (r.status === 429) limited++; }
  row("C: 2000 guesses at 1 account", c); console.log(`   rate_limited: ${limited}; D1 rows written during attack: ${c.d1Rows - before.d1Rows}`);
  const legit = await worker(env, c, "/login", { body: { login: "victim", key: key("v") }, ip: "1.1.1.1" });
  console.log(`   legit owner from another IP right after: HTTP ${legit.status} ${legit.json && legit.json.error ? legit.json.error : "ok"}`);
}

// ---- Scenario D: one valid account loops /login successfully (audit-row drain) ----
{
  const env = makeEnv(); const c = instrument(env);
  await worker(env, c, "/register", { body: { username: "Looper", key: key("l") }, ip: "2.2.2.2" });
  const before = c.d1Rows;
  for (let i = 0; i < 500; i++) await worker(env, c, "/login", { body: { login: "looper", key: key("l") }, ip: "2.2.2.2" });
  row("D: 500 successful logins", c); console.log(`   D1 rows written by the 500 logins: ${c.d1Rows - before} (uncapped would be ~${500 * 3})`);
}
