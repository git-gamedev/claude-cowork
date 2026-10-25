import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, fakeStorage, Room, call, key } from "./harness.mjs";

function sock(att) {
  return { att, sent: [], closed: null, deser: 0,
    serializeAttachment(a) { this.att = structuredClone(a); },
    deserializeAttachment() { this.deser++; return structuredClone(this.att); }, // real DOs clone on every call
    send(s) { this.sent.push(JSON.parse(s)); }, close(code) { this.closed = code; } };
}
function setup(n = 0) {
  const env = makeEnv();
  const ctx = { sockets: [], storage: fakeStorage(), getWebSockets() { return this.sockets; }, acceptWebSocket(w) { this.sockets.push(w); },
    setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp() { return null; } };
  const add = (uid, name, extra = {}) => {
    try { env.DB.raw.prepare("INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,token_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run(uid, name.toLowerCase(), name, name.toLowerCase(), "h", "k", 1, 0); } catch {} // same account may add a second socket in tests
    const s = sock({ uid, name, tv: 1, pid: null, gname: "", seen: Date.now(), sid: "s" + uid, ...extra }); ctx.sockets.push(s); return s;
  };
  for (let i = 0; i < n; i++) add("u" + i, "User" + i);
  return { env, ctx, add };
}
const msg = (room, ws, o) => room.webSocketMessage(ws, JSON.stringify(o));

test("per-operation attachment clones do not grow with room size", () => {
  const { env, ctx } = setup(150); const room = new Room(ctx, env);
  const s = ctx.sockets;
  msg(room, s[0], { t: "hello", pid: "1", gname: "g" });          // first call builds the index: 1 clone per socket
  const afterBuild = s.reduce((n, x) => n + x.deser, 0);
  assert.ok(afterBuild <= 160, `index build cloned ${afterBuild}`);
  for (let i = 1; i < 150; i++) msg(room, s[i], { t: "hello", pid: String(i + 1), gname: "g" });
  for (let i = 0; i < 150; i++) msg(room, s[i], { t: "lookup", ids: ["1", "2", "3"] });
  const total = s.reduce((n, x) => n + x.deser, 0);
  // 300 further operations on a 150-socket room; the old design needed ~150 clones per hello/lookup (>40k).
  assert.ok(total - afterBuild <= 600, `300 operations cloned ${total - afterBuild} attachments`);
  assert.equal(room.roster().length, 150);
});

test("a stale socket closing after replacement does not evict the new socket or free its pid", async () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  const oldS = add("u1", "Alice", { sid: "old" });
  msg(room, oldS, { t: "hello", pid: "7", gname: "g" });
  // Simulate the replacement the way fetch('/ws') does: kill the old entry, register a new live one with a new sid.
  const e = room.index().get("u1"); room.kill(e, 4000, "replaced");
  assert.equal(oldS.closed, 4000);
  const fresh = add("u1", "Alice", { sid: "new" }); room.idx.set("u1", { ws: fresh, a: structuredClone(fresh.att) });
  msg(room, fresh, { t: "hello", pid: "7", gname: "g" });
  room.webSocketClose(oldS);                                       // late close event of the replaced socket
  assert.ok(room.idx.get("u1"), "new entry survived");
  assert.equal(room.pids.get("7"), "u1", "pid still owned by the new socket");
});

test("closing a socket frees its pid, broadcasts leave, and the pid can be reclaimed", () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  const a = add("u1", "Alice"), b = add("u2", "Bob");
  msg(room, a, { t: "hello", pid: "5", gname: "g" }); msg(room, b, { t: "hello", pid: "6", gname: "h" });
  room.webSocketClose(a);
  assert.deepEqual(b.sent.at(-1), { t: "leave", pid: "5" });
  msg(room, b, { t: "hello", pid: "5", gname: "h" });              // reclaiming the freed pid works
  assert.equal(b.att.pid, "5");
  assert.equal(room.pids.has("6"), false);
});

test("the room user cache is bounded", async () => {
  const { env, ctx } = setup(); const room = new Room(ctx, env);
  for (let i = 0; i < 1000; i++) room.putRec("c" + i, "n", 1, false);
  assert.ok(room.cache.size <= 256);
});

test("chunked and oversized request bodies are rejected without being buffered", async () => {
  const env = makeEnv();
  const big = JSON.stringify({ username: "Alice", key: key(), pad: "x".repeat(5000) });
  const chunked = new ReadableStream({ start(c) { const e = new TextEncoder().encode(big); c.enqueue(e.slice(0, 1000)); c.enqueue(e.slice(1000)); c.close(); } });
  const { default: worker } = await import("../src/worker.js");
  const res = await worker.fetch(new Request("https://w/register", { method: "POST", body: chunked, duplex: "half", headers: { "CF-Connecting-IP": "9.9.9.9" } }), env, { waitUntil() {} });
  assert.equal(res.status, 400);
  assert.equal((await call(env, "/register", { body: { username: "Alice", key: key() } })).status, 200); // normal body still fine
});

test("base64url helpers round-trip through tokens of many sizes", async () => {
  const env = makeEnv();
  for (const name of ["abc", "a_b-c.d", "Z".repeat(16)]) {
    const r = await call(env, "/register", { body: { username: name, key: key("q") }, ip: "5.5." + name.length + ".1" });
    assert.equal(r.status, 200);
    assert.equal((await call(env, "/refresh", { token: r.json.token })).status, 200);
    assert.equal((await call(env, "/refresh", { token: r.json.token.slice(0, -2) + "AA" })).status, 401);
  }
});
