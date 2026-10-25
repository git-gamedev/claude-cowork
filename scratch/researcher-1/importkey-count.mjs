// Counts crypto.subtle.importKey calls per request (a thrashing key cache re-imports on every call).
import { makeEnv, call, key } from "../../src/gats-community/tests/harness.mjs";
let n = 0; const orig = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = (...a) => { n++; return orig(...a); };
const env = makeEnv();
const per = async (label, f) => { n = 0; await f(); console.log(label.padEnd(10), "importKey calls:", n); };
let tok;
await per("register", async () => { tok = (await call(env, "/register", { body: { username: "KeyUser", key: key("k") } })).json.token; });
await per("login", () => call(env, "/login", { body: { login: "keyuser", key: key("k") }, ip: "9.9.9.9" }));
await per("refresh", () => call(env, "/refresh", { token: tok }));
await per("rename", () => call(env, "/rename", { token: tok, body: { username: "KeyUser2" } }));
