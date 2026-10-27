// researcher-2: TEST-PASS scenarios F (+B slice) vs real workerd (wrangler dev --local). Read-only vs src/.
// Server never derives keys (client does PBKDF2), so any 43-char base64url string works as a "password key".
const BASE = process.env.BASE || "http://localhost:8788";
const rnd = Math.floor(Math.random() * 200) + 20; let n = 0;
const ip = () => `10.${rnd}.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const GOOD = "G".repeat(43), BAD = "W".repeat(43);
const sfx = Math.random().toString(36).slice(2, 6);
async function post(path, body, ipaddr = ip()) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ipaddr }, body: JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}
const reg = (u, a) => post("/register", { username: u, key: GOOD }, a);
const login = (u, key, a) => post("/login", { login: u, key }, a);
const row = (id, what, res, note) => console.log(`${res} | ${id} | ${what} | ${note}`);
const count = (arr) => arr.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
const first429 = (arr) => { const i = arr.indexOf(429); return i < 0 ? null : i + 1; };

// F1: successful logins are not throttled (fix for #9)
{ const u = `f1${sfx}`; await reg(u); const a = ip(); const s = [];
  for (let i = 0; i < 15; i++) s.push((await login(u, GOOD, a)).status);
  row("F1", "15 successful logins, one IP", s.every(x => x === 200) ? "PASS" : "FAIL", JSON.stringify(count(s))); }

// F2: unknown-login failures, one IPv4: expect lock after 20 (21st = 429)
{ const a = ip(); const s = [];
  for (let i = 0; i < 25; i++) s.push((await login(`nobody${sfx}`, BAD, a)).status);
  const f = first429(s); row("F2", "25 sequential failures (unknown login), one IP", f === 21 ? "PASS" : "FAIL", `first 429 at attempt ${f}; ${JSON.stringify(count(s))}`); }

// F3: per-account lockout across distinct IPs (known accepted griefing limit)
{ const u = `f3${sfx}`; await reg(u); const s = [];
  for (let i = 0; i < 12; i++) s.push((await login(u, BAD)).status);
  const good = (await login(u, GOOD)).status;
  const f = first429(s); row("F3", "12 wrong pw from 12 IPs, then correct pw", f === 11 ? "PASS" : "FAIL", `first 429 at attempt ${f}; correct pw afterwards -> ${good} (429 = lockout griefing confirmed)`); }

// F4: parallel burst vs one existing account (TOCTOU). Ideal: <=10 get 401.
{ const u = `f4${sfx}`; await reg(u); const a = ip();
  const s = (await Promise.all(Array.from({ length: 60 }, () => login(u, BAD, a)))).map(r => r.status);
  const c = count(s), ok401 = c[401] || 0;
  row("F4", "60 parallel wrong-pw logins, one account, one IP", ok401 <= 10 ? "PASS" : "FAIL", `${JSON.stringify(c)}; excess over limit 10 = ${Math.max(0, ok401 - 10)}`); }

// F5: parallel burst of unknown-login failures from one IP. Ideal: <=20 get 401.
{ const a = ip();
  const s = (await Promise.all(Array.from({ length: 60 }, () => login(`ghost${sfx}`, BAD, a)))).map(r => r.status);
  const c = count(s), ok401 = c[401] || 0;
  row("F5", "60 parallel failures (unknown login), one IP", ok401 <= 20 ? "PASS" : "FAIL", `${JSON.stringify(c)}; excess over limit 20 = ${Math.max(0, ok401 - 20)}`); }

// F6: IPv6 /64 grouping: 25 different addresses in the same /64 share one bucket
{ const s = [];
  for (let i = 0; i < 25; i++) s.push((await login(`v6${sfx}`, BAD, `2001:db8:${rnd.toString(16)}:1:${(i + 1).toString(16)}::1`)).status);
  const f = first429(s); row("F6", "25 failures from 25 addrs in one IPv6 /64", f === 21 ? "PASS" : "FAIL", `first 429 at attempt ${f}`); }

// F7: per-IP register limit (5/h)
{ const a = ip(); const s = [];
  for (let i = 0; i < 7; i++) s.push((await reg(`f7${sfx}${i}`, a)).status);
  row("F7", "7 registrations from one IP", JSON.stringify(s) === JSON.stringify([200,200,200,200,200,429,429]) ? "PASS" : "FAIL", JSON.stringify(s)); }

// B1: unknown user vs wrong password: same status and body?
{ const u = `f1${sfx}`; const a = await login(`nope${sfx}`, BAD), b = await login(u, BAD);
  const same = a.status === b.status && JSON.stringify(a.data) === JSON.stringify(b.data);
  row("B1", "unknown user vs wrong pw (fresh IPs)", same ? "PASS" : "FAIL", `unknown ${a.status} ${JSON.stringify(a.data)} | wrong ${b.status} ${JSON.stringify(b.data)}`); }

// R1: reserved-name variants (static read: exact lowercase match only). Informational.
{ const names = ["admin", "Admin", "admin.", "admin_", "admin-", "ad.min", "gats.io", "gats-io", "gats_io", "mod.", "root1", "system."];
  const res = [];
  for (const nm of names) res.push(`${nm}=${(await reg(nm + (nm.length < 3 ? "x" : ""))).status}`);
  const bypass = res.filter(x => x.endsWith("=200"));
  row("R1", "reserved-name variants register?", bypass.length ? "FAIL" : "PASS", `${res.join(" ")} ; 200 = registered despite reserved look-alike (only if not already taken from an earlier run)`); }
