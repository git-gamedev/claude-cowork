// Is the H1 growth the worker or the harness? Compare per-call retained bytes: /health (no crypto/DB), /refresh, bare Request+Response.
import { makeEnv, call, key } from "../../src/gats-community/tests/harness.mjs";
const gc = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const env = makeEnv();
const tok = (await call(env, "/register", { body: { username: "IsoUser", key: key("i") } })).json.token;
async function per(label, f, n = 10000) {
  for (let i = 0; i < 1000; i++) await f(); // warm
  const a = gc(); for (let i = 0; i < n; i++) await f(); const b = gc();
  const c0 = gc(); for (let i = 0; i < n; i++) await f(); const c = gc();
  console.log(label.padEnd(26), `first ${n}: ${(((b - a) / n)).toFixed(1)} B/call, next ${n}: ${(((c - c0) / n)).toFixed(1)} B/call`);
}
await per("bare Request/Response", async () => { await new Response(JSON.stringify({ a: 1 })).json(); new Request("https://w/x", { method: "POST", headers: { a: "b" } }); });
await per("/health", () => call(env, "/health", { method: "GET" }));
await per("/refresh", () => call(env, "/refresh", { token: tok }));
