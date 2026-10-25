// Allocation benchmark. Run from scratch/researcher-1:
//   node --expose-gc --max-semi-space-size=256 --no-warnings --import ../../src/gats-community/tests/register.mjs bench.mjs
// Metrics: (1) heapUsed delta per call with young-gen GC effectively off (approximate bytes allocated),
//          (2) deserializeAttachment() calls per Room alarm (each is a structured clone in workerd),
//          (3) retained heap after GC (leaks / unbounded structures).
import { makeEnv, call, key, Room, fakeStorage } from "../../src/gats-community/tests/harness.mjs";

const heap = () => process.memoryUsage().heapUsed;
const fmt = (n) => (n / 1024).toFixed(1) + " KiB";

// ---- (1) /refresh path: HMAC verify + D1 read + sign ----
const env = makeEnv();
const reg = await call(env, "/register", { body: { username: "BenchUser", key: key("b") } });
const token = reg.json.token;
for (let i = 0; i < 200; i++) await call(env, "/refresh", { token }); // warm up JIT + key cache
global.gc(); const h0 = heap(); const N = 3000;
for (let i = 0; i < N; i++) await call(env, "/refresh", { token });
const h1 = heap();
console.log(`refresh: ${((h1 - h0) / N).toFixed(0)} B/call allocated (incl. harness Request/Response)`);
global.gc(); console.log(`refresh: retained after GC vs start: ${fmt(heap() - h0)}`);

// ---- (2) Room.alarm with S sockets ----
function room(S) {
  const e = makeEnv(); let deser = 0;
  const sockets = [];
  const ctx = { storage: fakeStorage(), getWebSockets: () => sockets, acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp: () => null };
  for (let i = 0; i < S; i++) {
    e.DB.raw.prepare("INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,token_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run("u" + i, "user" + i, "User" + i, "user" + i, "h", "k", 1, 0);
    sockets.push({ att: { uid: "u" + i, name: "User" + i, tv: 1, pid: String(i), gname: "g" + i, seen: Date.now() },
      deserializeAttachment() { deser++; return structuredClone(this.att); }, serializeAttachment(a) { this.att = structuredClone(a); }, send() {}, close() {} });
  }
  return { r: new Room(ctx, e), count: () => deser, reset: () => (deser = 0) };
}
for (const S of [20, 100]) {
  const { r, count, reset } = room(S);
  await r.alarm(); reset(); global.gc(); const a0 = heap(); const M = 200;
  for (let i = 0; i < M; i++) await r.alarm();
  const a1 = heap();
  console.log(`alarm S=${S}: ${count() / M} deserializeAttachment/alarm, ${((a1 - a0) / M / 1024).toFixed(1)} KiB allocated/alarm`);
}
