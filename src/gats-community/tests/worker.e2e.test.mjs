import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, key } from "./harness.mjs";

const claims = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const count = (env, sql, ...a) => env.DB.raw.prepare(sql).get(...a).c;

test("register -> login -> refresh round trip, token claims", async () => {
  const env = makeEnv();
  const r = await call(env, "/register", { body: { username: "Alice", key: key("a") } });
  assert.equal(r.status, 200);
  assert.equal(claims(r.json.token).name, "Alice");
  assert.equal((await call(env, "/register", { body: { username: "alice", key: key("b") } })).status, 409);
  const l = await call(env, "/login", { body: { login: "ALICE", key: key("a") } });
  assert.equal(l.status, 200);
  assert.equal((await call(env, "/refresh", { token: l.json.token })).status, 200);
  assert.equal((await call(env, "/login", { body: { login: "alice", key: key("c") } })).status, 401);
  assert.equal((await call(env, "/login", { body: { login: "nobody", key: key("c") } })).status, 401);
});

test("input validation and reserved names", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/register", { body: { username: "a,b", key: key() } })).status, 400);
  assert.equal((await call(env, "/register", { body: { username: "ok_name", key: "short" } })).status, 400);
  assert.equal((await call(env, "/register", { body: { username: "Admin", key: key() } })).status, 409);
  let ipn = 0; // distinct IP per probe so the per-IP register limit does not mask the 409
  for (const n of ["admin.", "ad-min", "a.d.m.i.n", "adm1n", "admin1", "_admin", "gats_io", "gatsio", "m0derator", "moderator.", "st-aff", "0wner", "supp0rt", "r00t", "system."]) {
    assert.equal((await call(env, "/register", { body: { username: n, key: key() }, ip: "9.9.9." + (++ipn) })).status, 409, n);
  }
  assert.equal((await call(env, "/register", { body: { username: "adminton", key: key() }, ip: "9.9.9.200" })).status, 200, "non-reserved lookalike prefix stays allowed");
});

test("tampered / garbage tokens are rejected", async () => {
  const env = makeEnv();
  const r = await call(env, "/register", { body: { username: "bob", key: key() } });
  const [v, p, s] = r.json.token.split(".");
  const evil = Buffer.from(JSON.stringify({ ...claims(r.json.token), name: "root" })).toString("base64url");
  assert.equal((await call(env, "/refresh", { token: `${v}.${evil}.${s}` })).status, 401);
  assert.equal((await call(env, "/refresh", { token: "garbage" })).status, 401);
});

test("failed logins lock the login, write NOTHING to D1, and survive Gate eviction", async () => {
  const env = makeEnv();
  await call(env, "/register", { body: { username: "victim", key: key("a") } });
  const before = count(env, "SELECT COUNT(*) c FROM events");
  for (let i = 0; i < 10; i++) assert.equal((await call(env, "/login", { body: { login: "victim", key: key("z") }, ip: "9.9." + i + ".1" })).status, 401);
  assert.equal(count(env, "SELECT COUNT(*) c FROM events"), before, "failed logins must not write D1");
  env.GATE.evict("l:victim"); // eviction must not reset the window
  const locked = await call(env, "/login", { body: { login: "victim", key: key("a") }, ip: "8.8.8.8" });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error, "rate_limited");
});

test("a few typos then success does not lock; success resets the login counter", async () => {
  const env = makeEnv();
  await call(env, "/register", { body: { username: "carol", key: key("a") } });
  for (let i = 0; i < 4; i++) await call(env, "/login", { body: { login: "carol", key: key("z") } });
  assert.equal((await call(env, "/login", { body: { login: "carol", key: key("a") } })).status, 200);
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 9; i++) await call(env, "/login", { body: { login: "carol", key: key("z") } });
  assert.equal((await call(env, "/login", { body: { login: "carol", key: key("a") } })).status, 200);
});

test("per-IP failure limit hits sprayers across many logins; IPv6 /64 shares a bucket", async () => {
  const env = makeEnv();
  for (let i = 0; i < 30; i++) await call(env, "/login", { body: { login: "user" + i + "xx", key: key("z") }, ip: "2001:db8:1:2:aaaa::" + i });
  const r = await call(env, "/login", { body: { login: "someoneelse", key: key("z") }, ip: "2001:db8:1:2:ffff::1" });
  assert.equal(r.status, 429);
});

test("signup cap: 5 per IP per hour", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await call(env, "/register", { body: { username: "user" + i + "abc", key: key("a") }, ip: "5.5.5.5" })).status, 200);
  assert.equal((await call(env, "/register", { body: { username: "user9abc", key: key("a") }, ip: "5.5.5.5" })).status, 429);
  assert.equal((await call(env, "/register", { body: { username: "user9abc", key: key("a") }, ip: "6.6.6.6" })).status, 200);
});

test("rename: ok, cooldown, duplicate, revoked", async () => {
  const env = makeEnv();
  const a = await call(env, "/register", { body: { username: "dave", key: key("a") }, ip: "1.1.1.1" });
  await call(env, "/register", { body: { username: "erin", key: key("b") }, ip: "1.1.1.2" });
  const r1 = await call(env, "/rename", { token: a.json.token, body: { username: "Dave2" } });
  assert.equal(r1.status, 200);
  assert.equal(claims(r1.json.token).name, "Dave2");
  const r2 = await call(env, "/rename", { token: r1.json.token, body: { username: "Dave3" } });
  assert.equal(r2.status, 429);
  assert.equal(r2.json.error, "rename_cooldown");
  env.DB.raw.exec("UPDATE users SET renamed_at=0");
  assert.equal((await call(env, "/rename", { token: r1.json.token, body: { username: "erin" } })).status, 409);
  env.DB.raw.exec("UPDATE users SET token_version=token_version+1 WHERE login=\x27dave\x27");
  assert.equal((await call(env, "/rename", { token: r1.json.token, body: { username: "Dave4" } })).status, 401);
});

test("admin ban: wrong key rejected, ban blocks login/refresh/rename", async () => {
  const env = makeEnv();
  const a = await call(env, "/register", { body: { username: "frank", key: key("a") } });
  assert.equal((await call(env, "/admin/ban", { body: { login: "frank" }, headers: { "X-Admin-Key": "nope" } })).status, 401);
  assert.equal((await call(env, "/admin/ban", { body: { login: "frank", reason: "x" }, headers: { "X-Admin-Key": "adminkey" } })).status, 200);
  assert.equal((await call(env, "/login", { body: { login: "frank", key: key("a") } })).status, 403);
  assert.equal((await call(env, "/refresh", { token: a.json.token })).status, 401);
  assert.equal((await call(env, "/rename", { token: a.json.token, body: { username: "frank2" } })).status, 401);
});

test("unknown login names never spawn per-account Gates", async () => {
  const env = makeEnv();
  const seen = [];
  const orig = env.GATE.get; env.GATE.get = (n) => { seen.push(n); return orig(n); };
  for (let i = 0; i < 3; i++) await call(env, "/login", { body: { login: "ghost" + i + "xx", key: key("z") } });
  assert.ok(!seen.some((n) => n.startsWith("ll:")), "no ll:* gate for nonexistent accounts");
  assert.ok(seen.some((n) => n.startsWith("li:")), "IP gate still counts");
});

test("a valid account looping /login stops writing audit rows after 20/hour but still logs in", async () => {
  const env = makeEnv();
  await call(env, "/register", { body: { username: "looper", key: key("a") } });
  const logins = () => env.DB.raw.prepare("SELECT COUNT(*) c FROM events WHERE type=\x27login\x27").get().c;
  for (let i = 0; i < 25; i++) assert.equal((await call(env, "/login", { body: { login: "looper", key: key("a") } })).status, 200);
  assert.equal(logins(), 20);
});
