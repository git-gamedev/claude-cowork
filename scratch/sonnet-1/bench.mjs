// node --expose-gc --max-semi-space-size=512 --no-warnings --import ../../src/gats-community/tests/register.mjs bench.mjs
// Compares the pre-optimization Room (baseline/room.js = src/room.js@02c7a7b) with the current one.
import { Room as NewRoom } from "../../src/gats-community/src/room.js";
import { Room as OldRoom } from "./baseline/room.js";

const N = Number(process.env.N || 150);
function sock(att) {
  return { att, clones: 0, sends: 0,
    serializeAttachment(a) { this.att = structuredClone(a); },
    deserializeAttachment() { this.clones++; return structuredClone(this.att); }, // what workerd does on every call
    send() { this.sends++; }, close() {} };
}
function mkCtx() {
  const ctx = { sockets: [], getWebSockets() { return this.sockets; }, acceptWebSocket(w) { this.sockets.push(w); },
    setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp() { return null; },
    storage: { getAlarm: async () => null, setAlarm: async () => {} } };
  for (let i = 0; i < N; i++) ctx.sockets.push(sock({ uid: "u" + i, name: "User" + i, tv: 1, pid: null, gname: "", seen: Date.now(), sid: "s" + i }));
  return ctx;
}
const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: Array.from({ length: N }, (_, i) => ({ id: "u" + i, username: "User" + i, token_version: 1, banned: 0 })) }), first: async () => null }) }) } };
const m = (room, ws, o) => room.webSocketMessage(ws, JSON.stringify(o));

async function run(label, Room) {
  global.gc(); const ctx = mkCtx(); const room = new Room(ctx, env);
  const h0 = process.memoryUsage().heapUsed; const t0 = performance.now();
  for (let i = 0; i < N; i++) m(room, ctx.sockets[i], { t: "hello", pid: String(i + 1), gname: "g" + i });
  for (let i = 0; i < N; i++) m(room, ctx.sockets[i], { t: "lookup", ids: ["1", "2", "3", "4", "5"] });
  for (let i = 0; i < N; i++) m(room, ctx.sockets[i], { t: "bye" });
  await room.alarm();
  const ms = performance.now() - t0; const heap = process.memoryUsage().heapUsed - h0;
  const clones = ctx.sockets.reduce((n, s) => n + s.clones, 0);
  console.log(`${label.padEnd(9)} sockets=${N}  attachment clones=${String(clones).padStart(7)}  heap allocated~${(heap / 1048576).toFixed(1).padStart(6)} MB  time=${ms.toFixed(0)} ms`);
}
await run("baseline", OldRoom); await run("optimized", NewRoom);
await run("baseline", OldRoom); await run("optimized", NewRoom);

// ---- base64url helpers: old vs new ----
const old = { enc(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const s = str.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); } };
const F = { "+": "-", "/": "_", "=": "" };
const cur = { enc(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); return btoa(String.fromCharCode.apply(null, b)).replace(/[+/=]/g, (c) => F[c]); },
  dec(str) { const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(bin.length); for (let i = 0; i < o.length; i++) o[i] = bin.charCodeAt(i); return o; } };
const sample = crypto.getRandomValues(new Uint8Array(32)); const text = old.enc(sample);
for (const [k, h] of [["old b64u", old], ["new b64u", cur]]) {
  global.gc(); const h0 = process.memoryUsage().heapUsed; const t0 = performance.now();
  for (let i = 0; i < 200000; i++) { h.dec(h.enc(sample)); h.dec(text); }
  console.log(`${k}  200k enc+dec x2: ${(performance.now() - t0).toFixed(0)} ms, heap allocated~${((process.memoryUsage().heapUsed - h0) / 1048576).toFixed(0)} MB`);
}
