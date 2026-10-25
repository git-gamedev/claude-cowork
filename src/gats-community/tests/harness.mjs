// Test harness: real SQLite (node:sqlite) behind a D1-shaped API, plus in-process Durable Objects.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { Room } from "../src/room.js";
import { Gate } from "../src/gate.js";

const here = new URL("../", import.meta.url);

export function makeDB() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["schema.sql", "schema_002.sql"]) db.exec(readFileSync(new URL(f, here), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    _run: () => db.prepare(sql).run(...args),
    async run() { const r = this._run(); return { meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec("BEGIN");
      try { for (const s of list) s._run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      return [];
    },
  };
}

export function fakeStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k), getAlarm: async () => null, setAlarm: async () => {}, deleteAll: async () => m.clear() };
}

export function makeEnv(extra = {}) {
  const gates = new Map(), storages = new Map();
  const env = {
    DB: makeDB(), TOKEN_SECRET: "t".repeat(40), PEPPER: "p".repeat(40), ADMIN_KEY: "adminkey",
    ALLOWED_ROOM_SUFFIX: "gats.io", ROOM_SUFFIX: "gats.io",
    GATE: {
      idFromName: (n) => n,
      get: (n) => ({ fetch: (url) => { if (!gates.has(n)) { if (!storages.has(n)) storages.set(n, fakeStorage()); gates.set(n, new Gate({ storage: storages.get(n) }, env)); } return gates.get(n).fetch(new Request(url)); } }),
      evict: (n) => gates.delete(n), // simulate the runtime evicting an idle object (storage survives)
    },
    ROOMS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("ok") }) },
    ...extra,
  };
  return env;
}

export const ctx = { waitUntil: (p) => p.catch(() => {}) };
export async function call(env, path, { body, token, ip = "1.2.3.4", method = "POST", headers = {} } = {}) {
  const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers };
  if (token) h.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
export const key = (c = "a") => c.repeat(43);
export { Room, Gate };
