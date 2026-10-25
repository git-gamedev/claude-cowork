// node --trace-gc --no-warnings --import ../../src/gats-community/tests/register.mjs gcbench.mjs old|new
import { Room as NewRoom } from "../../src/gats-community/src/room.js";
import { Room as OldRoom } from "./baseline/room.js";
const Room = process.argv[2] === "old" ? OldRoom : NewRoom; const N = 150;
function sock(att) { return { att, serializeAttachment(a) { this.att = structuredClone(a); }, deserializeAttachment() { return structuredClone(this.att); }, send() {}, close() {} }; }
for (let round = 0; round < 40; round++) {
  const ctx = { sockets: [], getWebSockets() { return this.sockets; }, acceptWebSocket() {}, setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp() { return null; }, storage: { getAlarm: async () => null, setAlarm: async () => {} } };
  for (let i = 0; i < N; i++) ctx.sockets.push(sock({ uid: "u" + i, name: "U" + i, tv: 1, pid: null, gname: "", seen: Date.now(), sid: "s" + i }));
  const room = new Room(ctx, {}); const m = (ws, o) => room.webSocketMessage(ws, JSON.stringify(o));
  for (let i = 0; i < N; i++) m(ctx.sockets[i], { t: "hello", pid: String(i + 1), gname: "g" });
  for (let i = 0; i < N; i++) m(ctx.sockets[i], { t: "lookup", ids: ["1", "2", "3"] });
}
