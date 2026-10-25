import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, fakeStorage, Room } from "./harness.mjs";

function fakeSocket(att) {
  return { att, sent: [], closed: null,
    serializeAttachment(a) { this.att = structuredClone(a); }, deserializeAttachment() { return this.att; },
    send(s) { this.sent.push(JSON.parse(s)); }, close(code) { this.closed = code; } };
}
function setup() {
  const env = makeEnv();
  const ctx = { sockets: [], storage: fakeStorage(), getWebSockets() { return this.sockets; }, acceptWebSocket(w) { this.sockets.push(w); },
    setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp() { return null; } };
  const add = (uid, name, tv = 1) => { env.DB.raw.prepare("INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,token_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run(uid, name.toLowerCase(), name, name.toLowerCase(), "h", "k", tv, 0);
    const s = fakeSocket({ uid, name, tv, pid: null, seen: Date.now() }); ctx.sockets.push(s); return s; };
  return { env, ctx, add };
}
const msg = (room, ws, o) => room.webSocketMessage(ws, JSON.stringify(o));

test("hello/roster/join carry gname; pid collisions rejected; lookup returns name+gname", () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  const a = add("u1", "Alice"), b = add("u2", "Bob");
  msg(room, a, { t: "hello", pid: "11", gname: "guestA" });
  msg(room, b, { t: "hello", pid: "22", gname: "guestB" });
  assert.deepEqual(a.sent.at(-1), { t: "join", pid: "22", name: "Bob", gname: "guestB" });
  assert.deepEqual(b.sent.find((m) => m.t === "roster").players, [{ pid: "11", name: "Alice", gname: "guestA" }, { pid: "22", name: "Bob", gname: "guestB" }]); // roster includes the requester; client skips its own pid
  msg(room, b, { t: "hello", pid: "11", gname: "x" });
  assert.equal(b.sent.at(-1).code, "pid_taken");
  msg(room, a, { t: "lookup", ids: ["22", "99"] });
  assert.deepEqual(a.sent.at(-1).names, { 22: { name: "Bob", gname: "guestB" } });
  msg(room, a, { t: "hello", pid: "bad pid!", gname: "x" });
  assert.equal(a.sent.at(-1).code, "bad_pid");
});

test("alarm revalidation runs on a FRESH instance (post-hibernation) and drops banned/revoked sockets (#8)", async () => {
  const { env, ctx, add } = setup();
  const a = add("u1", "Alice"), b = add("u2", "Bob"), c = add("u3", "Cy");
  msg(new Room(ctx, env), a, { t: "hello", pid: "1", gname: "g" });
  env.DB.raw.exec("UPDATE users SET banned=1 WHERE id=\x27u1\x27; UPDATE users SET token_version=2 WHERE id=\x27u2\x27; UPDATE users SET username=\x27Cyrus\x27 WHERE id=\x27u3\x27");
  msg(new Room(ctx, env), c, { t: "hello", pid: "3", gname: "g3" });
  const fresh = new Room(ctx, env); // brand-new instance, as after hibernation
  await fresh.alarm();
  assert.equal(a.closed, 4002); assert.equal(b.closed, 4002); assert.equal(c.closed, null);
  assert.equal(c.att.name, "Cyrus");
});

test("silent sockets time out", async () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  const a = add("u1", "Alice"); a.att.seen = Date.now() - 10 * 60_000;
  await room.alarm();
  assert.equal(a.closed, 4001);
});

test("rename and kick via internal endpoints", async () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  const a = add("u1", "Alice"), b = add("u2", "Bob");
  msg(room, a, { t: "hello", pid: "1", gname: "g1" }); msg(room, b, { t: "hello", pid: "2", gname: "g2" });
  await room.fetch(new Request("https://r/rename", { method: "POST", body: JSON.stringify({ uid: "u1", name: "Alicia" }) }));
  assert.deepEqual(b.sent.at(-1), { t: "rename", pid: "1", name: "Alicia", gname: "g1" });
  await room.fetch(new Request("https://r/kick", { method: "POST", body: JSON.stringify({ uid: "u2" }) }));
  assert.equal(b.closed, 4002);
});

test("websocket upgrade is refused for banned users and token-version mismatch", async () => {
  const { env, ctx, add } = setup(); const room = new Room(ctx, env);
  add("u1", "Alice", 1);
  const up = (uid, tv) => room.fetch(new Request("https://r/ws", { headers: { Upgrade: "websocket", "x-uid": uid, "x-tv": String(tv) } }));
  assert.equal((await up("u1", 9)).status, 401);
  assert.equal((await up("ghost", 1)).status, 401);
});
