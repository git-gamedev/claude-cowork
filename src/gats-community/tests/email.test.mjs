import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeDB, call, key } from "./harness.mjs";

// Controllable clock: Gate, Verifier and token expiry all read Date.now().
function clock() {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  return { adv: (ms) => { t += ms; }, restore: () => { Date.now = real; } };
}
function mailEnv(extra = {}) {
  const sent = [];
  const env = makeEnv({ EMAIL_VERIFY: "on", MAILER: async (to, code) => { sent.push({ to, code }); }, ...extra });
  return { env, sent };
}
const DEV1 = "d".repeat(22), DEV2 = "e".repeat(22);
const reg = (env, name, email, o = {}) => call(env, "/register", { body: { username: name, key: key(o.k || "a"), email, dev: o.dev }, ip: o.ip || "10.0.0.1" });
const log = (env, name, o = {}) => call(env, "/login", { body: { login: name, key: key(o.k || "a"), dev: o.dev }, ip: o.ip || "10.0.0.1" });
const ver = (env, ticket, code, ip = "10.0.0.1") => call(env, "/verify", { body: { ticket, code }, ip });
const wrongOf = (code) => (code === "000000" ? "111111" : "000000");

test("feature off: register/login work and the code does not need schema_003", async () => {
  const env = makeEnv({ DB: makeDB(["schema.sql", "schema_002.sql"]) });
  const r = await call(env, "/register", { body: { username: "olduser", key: key() } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  assert.equal((await log(env, "olduser")).status, 200);
  assert.equal((await call(env, "/verify", { body: {} })).status, 404);
});

test("register: email required, code mailed, no session until verified; success returns a session and trusts the device", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    assert.equal((await reg(env, "alice", "not-an-email")).json.error, "invalid_email");
    const r = await reg(env, "alice", "Alice@Example.COM", { dev: DEV1 });
    assert.equal(r.status, 202);
    assert.equal(r.json.verify, "code");
    assert.equal(r.json.hint, "a***@example.com");
    assert.equal(r.json.token, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "alice@example.com");
    assert.match(sent[0].code, /^\d{6}$/);
    // a ticket is not a session token
    assert.equal((await call(env, "/refresh", { token: r.json.ticket })).status, 401);
    assert.equal((await call(env, "/rename", { token: r.json.ticket, body: { username: "Alice2" } })).status, 401);
    const v = await ver(env, r.json.ticket, sent[0].code);
    assert.equal(v.status, 200);
    assert.ok(v.json.token);
    const row = env.DB.raw.prepare("SELECT email_verified_at FROM users WHERE login='alice'").get();
    assert.ok(row.email_verified_at > 0);
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM devices").get().n, 1);
    // the code is single use
    assert.equal((await ver(env, r.json.ticket, sent[0].code)).json.error, "code_expired");
    // known device: straight in, no mail. Unknown or missing device: code.
    c.adv(61000);
    assert.equal((await log(env, "alice", { dev: DEV1 })).status, 200);
    assert.equal(sent.length, 1);
    const n = await log(env, "alice", { dev: DEV2 });
    assert.equal(n.status, 202);
    assert.equal(n.json.purpose, "device");
    assert.equal(sent.length, 2);
    c.adv(61000);
    assert.equal((await log(env, "alice")).status, 202); // client without a device id
    assert.equal(sent.length, 3);
  } finally { c.restore(); }
});

test("wrong codes: 5 per code, then the code dies; the account is never locked", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    const r = await reg(env, "bob", "bob@example.com", { dev: DEV1 });
    const bad = wrongOf(sent[0].code);
    const first = await ver(env, r.json.ticket, bad);
    assert.equal(first.status, 401);
    assert.equal(first.json.error, "code_invalid");
    assert.equal(first.json.left, 4);
    for (let i = 0; i < 3; i++) await ver(env, r.json.ticket, bad);
    const dead = await ver(env, r.json.ticket, bad);
    assert.equal(dead.status, 410);
    assert.equal((await ver(env, r.json.ticket, sent[0].code)).status, 410); // right code, but the code is dead
    // Password login still works from ANOTHER IP and gets a fresh code, and finishes.
    c.adv(61000);
    const l = await log(env, "bob", { dev: DEV1, ip: "10.0.0.9" });
    assert.equal(l.status, 202);
    assert.equal(sent.length, 2);
    const ok = await ver(env, l.json.ticket, sent[1].code, "10.0.0.9");
    assert.equal(ok.status, 200);
  } finally { c.restore(); }
});

test("10 wrong codes bans that IP (login, register, verify) for the window; other IPs and the account are unaffected", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    const r = await reg(env, "carol", "carol@example.com", { dev: DEV1 });
    const bad = wrongOf(sent[0].code);
    for (let i = 0; i < 5; i++) await ver(env, r.json.ticket, bad); // code 1 dead (5 counted failures)
    c.adv(61000);
    const rs = await call(env, "/resend", { body: { ticket: r.json.ticket }, ip: "10.0.0.1" });
    assert.equal(rs.status, 202);
    const bad2 = wrongOf(sent[1].code);
    let last;
    for (let i = 0; i < 5; i++) last = await ver(env, r.json.ticket, bad2); // failures 6..10
    assert.equal(last.status, 429);
    assert.equal(last.json.error, "ip_banned");
    // banned IP: even the correct code, login and register are refused
    assert.equal((await ver(env, rs.json.ticket, sent[1].code)).json.error, "ip_banned");
    assert.equal((await log(env, "carol", { dev: DEV1 })).json.error, "ip_banned");
    assert.equal((await reg(env, "carol2", "c2@example.com")).json.error, "ip_banned");
    // The 2nd code took the guesses and is dead. Another IP can log in with the password, get a fresh code and finish:
    // the account itself is not locked, only the abusive IP.
    c.adv(61000);
    const other = await log(env, "carol", { dev: DEV1, ip: "10.0.0.77" });
    assert.equal(other.status, 202);
    const ok = await ver(env, other.json.ticket, sent[sent.length - 1].code, "10.0.0.77");
    assert.equal(ok.status, 200);
    // the ban is temporary: it ends with the hour window
    c.adv(3600 * 1000 + 1000);
    assert.equal((await log(env, "carol", { dev: DEV1 })).status, 200);
  } finally { c.restore(); }
});

test("resend: 60 s cooldown and 5 sends per hour per account", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    const r = await reg(env, "dave", "dave@example.com", { dev: DEV1 });
    const t = r.json.ticket;
    const early = await call(env, "/resend", { body: { ticket: t } });
    assert.equal(early.status, 429);
    assert.equal(early.json.error, "resend_cooldown");
    assert.ok(early.json.retryAfter > 0);
    for (let i = 0; i < 4; i++) { c.adv(61000); assert.equal((await call(env, "/resend", { body: { ticket: t }, ip: "10.1.0." + i })).status, 202); }
    assert.equal(sent.length, 5);
    c.adv(61000);
    const sixth = await call(env, "/resend", { body: { ticket: t }, ip: "10.1.0.99" });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error, "rate_limited");
    assert.equal(sent.length, 5);
  } finally { c.restore(); }
});

test("code expires after 10 minutes", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    const r = await reg(env, "erin", "erin@example.com", { dev: DEV1 });
    c.adv(9 * 60000);
    const t2 = (await call(env, "/resend", { body: { ticket: r.json.ticket } })).json.ticket; // fresh 10-min ticket and a new code
    c.adv(10 * 60000 + 1000);
    assert.equal((await ver(env, t2, sent[1].code)).json.error, "ticket_expired"); // ticket (10 min) is the first thing to lapse
    const l = await log(env, "erin", { dev: DEV1 });
    assert.equal(l.status, 202);
    c.adv(10 * 60000 + 1000);
    assert.equal((await ver(env, l.json.ticket, sent[2].code)).json.error, "ticket_expired");
  } finally { c.restore(); }
});

test("email budget: global daily cap stops sending, leaves no live code, and reports email_busy", async () => {
  const { env, sent } = mailEnv({ MAIL_DAILY_CAP: "2" });
  assert.equal((await reg(env, "user1", "u1@example.com", { ip: "10.2.0.1" })).status, 202);
  assert.equal((await reg(env, "user2", "u2@example.com", { ip: "10.2.0.2" })).status, 202);
  const third = await reg(env, "user3", "u3@example.com", { ip: "10.2.0.3" });
  assert.equal(third.status, 503);
  assert.equal(third.json.error, "email_busy");
  assert.equal(sent.length, 2);
});

test("provider failure: 502, code cleared; unverified row can retry through login later", async () => {
  const c = clock();
  try {
    let fail = true;
    const sent = [];
    const env = makeEnv({ EMAIL_VERIFY: "on", MAILER: async (to, code) => { if (fail) throw new Error("boom"); sent.push({ to, code }); } });
    const r = await reg(env, "fay", "fay@example.com", { dev: DEV1 });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "email_failed");
    fail = false;
    c.adv(61000);
    const l = await log(env, "fay", { dev: DEV1 });
    assert.equal(l.status, 202);
    assert.equal((await ver(env, l.json.ticket, sent[0].code)).status, 200);
  } finally { c.restore(); }
});

test("one account per address; never-verified signups release name and address after 1 hour", async () => {
  const c = clock();
  try {
    const { env } = mailEnv();
    assert.equal((await reg(env, "gus", "gus@example.com", { ip: "10.3.0.1" })).status, 202);
    const dup = await reg(env, "gus2", "GUS@example.com", { ip: "10.3.0.2" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, "email_taken");
    assert.equal((await reg(env, "gus", "other@example.com", { ip: "10.3.0.3" })).json.error, "name_taken");
    c.adv(3600 * 1000 + 1000);
    assert.equal((await reg(env, "gus2", "gus@example.com", { ip: "10.3.0.4" })).status, 202);
    assert.equal((await reg(env, "gus", "other@example.com", { ip: "10.3.0.5" })).status, 202);
  } finally { c.restore(); }
});

test("accounts created before the feature: password login, attach an email, verify, then in", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv({ EMAIL_VERIFY: "off" });
    assert.equal((await call(env, "/register", { body: { username: "legacy", key: key() } })).status, 200);
    env.EMAIL_VERIFY = "on";
    const l = await log(env, "legacy", { dev: DEV1 });
    assert.equal(l.status, 202);
    assert.equal(l.json.purpose, "email_needed");
    assert.equal(sent.length, 0);
    assert.equal((await ver(env, l.json.ticket, "123456")).json.error, "ticket_expired"); // wrong ticket purpose
    assert.equal((await call(env, "/email", { body: { ticket: l.json.ticket, email: "nope" } })).json.error, "invalid_email");
    const e = await call(env, "/email", { body: { ticket: l.json.ticket, email: "Legacy@Example.com" } });
    assert.equal(e.status, 202);
    assert.equal(sent.length, 1);
    const ok = await ver(env, e.json.ticket, sent[0].code);
    assert.equal(ok.status, 200);
    assert.equal((await log(env, "legacy", { dev: DEV1 })).status, 200); // device now trusted
  } finally { c.restore(); }
});

test("device list is capped at 10 per account", async () => {
  const c = clock();
  try {
    const { env, sent } = mailEnv();
    const r = await reg(env, "hal", "hal@example.com", { dev: "a".repeat(22) });
    assert.equal((await ver(env, r.json.ticket, sent[0].code)).status, 200);
    for (let i = 0; i < 11; i++) {
      c.adv(13 * 60000); // stays under the 5 sends/hour per-account cap
      const dev = String.fromCharCode(98 + i).repeat(22);
      const l = await log(env, "hal", { dev, ip: "10.4.0." + i });
      assert.equal(l.status, 202);
      assert.equal((await ver(env, l.json.ticket, sent[sent.length - 1].code, "10.4.0." + i)).status, 200);
    }
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM devices").get().n, 10);
  } finally { c.restore(); }
});
