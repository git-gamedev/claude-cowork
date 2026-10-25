// Tester pass, scenario H (resource use). Run from scratch/researcher-1:
//   node --expose-gc --no-warnings --import ../../src/gats-community/tests/register.mjs h-resource.mjs
// Node harness only (real SQLite shim, in-process DOs). NOT workerd: heap numbers are V8-in-Node, indicative only.
import { makeEnv, call, key, Room, fakeStorage } from "../../src/gats-community/tests/harness.mjs";
import worker from "../../src/gats-community/src/worker.js";

const gc = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const kib = (n) => (n / 1024).toFixed(1) + " KiB";
const results = [];
const rec = (id, what, pass, note) => { results.push({ id, what, pass, note }); console.log(`${id} ${pass ? "PASS" : "FAIL"} ${what}: ${note}`); };

// H1: leak check. After a warm-up (V8 caches, undici internals), two equal batches must retain ~0 more heap.
// (First version compared 2k vs 8k calls with no warm-up and false-failed: growth decays to ~0 once warm, see h1-isolate.mjs.)
{
  const env = makeEnv();
  const tok = (await call(env, "/register", { body: { username: "LeakUser", key: key("l") } })).json.token;
  const run = async (n) => { for (let i = 0; i < n; i++) await call(env, "/refresh", { token: tok }); };
  await run(12000); const a = gc(); await run(10000); const b = gc(); await run(10000); const c = gc();
  rec("H1", "/refresh retained heap, two warm batches of 10k calls", c - b < 100 * 1024, `batch1 ${kib(b - a)}, batch2 ${kib(c - b)} (flat = no leak)`);
}

// H2: oversized and chunked bodies are rejected without being buffered
{
  const env = makeEnv();
  const big = "x".repeat(5 * 1024 * 1024);
  const r1 = await worker.fetch(new Request("https://w/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.5" }, body: JSON.stringify({ login: "abc", key: key(), pad: big }) }), env, { waitUntil() {} });
  const chunked = new ReadableStream({ start(c) { for (let i = 0; i < 400; i++) c.enqueue(new TextEncoder().encode("y".repeat(16384))); c.close(); } });
  const r2 = await worker.fetch(new Request("https://w/login", { method: "POST", duplex: "half", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.6" }, body: chunked }), env, { waitUntil() {} });
  rec("H2", "5 MB body and 6.5 MB chunked body", r1.status === 400 && r2.status === 400, `HTTP ${r1.status} / ${r2.status} (expect 4xx, no 500)`);
}

// H3: Room user cache stays bounded, many distinct users connecting
{
  const env = makeEnv();
  const ctx = { storage: fakeStorage(), getWebSockets: () => [], acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp: () => null };
  const room = new Room(ctx, env);
  for (let i = 0; i < 3000; i++) env.DB.raw.prepare("INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,token_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run("c" + i, "cu" + i, "CU" + i, "cu" + i, "h", "k", 1, 0);
  for (let i = 0; i < 3000; i++) await room.userRec("c" + i);
  rec("H3", "Room.cache size after 3000 distinct users", room.cache.size <= 2000, `size ${room.cache.size}`);
}

// H4: 300 sockets, 150 alarm sweeps: no growth, bounded per-sweep allocation
{
  const env = makeEnv(); const S = 300;
  const sockets = [];
  const ctx = { storage: fakeStorage(), getWebSockets: () => sockets, acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp: () => null };
  for (let i = 0; i < S; i++) {
    env.DB.raw.prepare("INSERT INTO users (id,login,username,username_lc,pw_hash,kdf,token_version,created_at) VALUES (?,?,?,?,?,?,?,?)").run("s" + i, "su" + i, "SU" + i, "su" + i, "h", "k", 1, 0);
    sockets.push({ att: { uid: "s" + i, name: "SU" + i, tv: 1, pid: String(i), gname: "g" + i, seen: Date.now() }, deserializeAttachment() { return structuredClone(this.att); }, serializeAttachment(a) { this.att = structuredClone(a); }, send() {}, close() { this.closed = true; } });
  }
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await new Room(ctx, env).alarm(); // fresh instance each time, like post-hibernation
  const a = gc();
  for (let i = 0; i < 130; i++) await new Room(ctx, env).alarm();
  const b = gc();
  const dead = sockets.filter((s) => s.closed).length;
  rec("H4", `${S} sockets, 150 fresh-instance alarms`, Math.abs(b - a) < 512 * 1024 && dead === 0, `heap delta over last 130 sweeps ${kib(b - a)}, wrongly closed ${dead}, ${((performance.now() - t0) / 150).toFixed(1)} ms/sweep (Node, incl. SQLite shim)`);
}

// H5: Gate holds one record, no per-hit growth
{
  const env = makeEnv();
  const a0 = gc();
  for (let i = 0; i < 20000; i++) await call(env, "/login", { body: { login: "nobody", key: key("n") }, ip: "7.7.7.7" });
  const a1 = gc();
  rec("H5", "20,000 failed logins from one IP", a1 - a0 < 1024 * 1024, `heap growth ${kib(a1 - a0)}`);
}

console.log("\n| id | how run | result |\n|---|---|---|");
for (const r of results) console.log(`| ${r.id} | node harness | ${r.pass ? "PASS" : "FAIL"}: ${r.note} |`);
