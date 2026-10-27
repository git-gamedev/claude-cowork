// researcher-2: remaining #31/#32 pieces on real workerd. Usage: node limits2.mjs <ren|caps|persistA|persistB> <tag>
// Phases must run against ONE local state dir; persistA and persistB straddle a wrangler dev restart.
const BASE = process.env.BASE || "http://localhost:8788";
const phase = process.argv[2], tag = process.argv[3] || "abc";
const GOOD = "G".repeat(43), BAD = "W".repeat(43);
async function post(path, body, ip, h = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...h }, body: JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}
const row = (id, what, ok, note) => console.log(`${ok ? "PASS" : "FAIL"} | ${id} | ${what} | ${note}`);
const IPX = `203.0.113.${(tag.charCodeAt(0) % 200) + 1}`; // fixed per tag so persistA/B share the same IP bucket

if (phase === "ren") {
  const u = `ren${tag}`;
  const reg = await post("/register", { username: u, key: GOOD }, "198.51.100.10");
  const tok = reg.data.token, ip = "198.51.100.11", out = [];
  for (let i = 1; i <= 12; i++) {
    const r = await post("/rename", { username: `Rn${tag}${i}` }, ip, { authorization: "Bearer " + tok });
    out.push(`${r.status}:${r.data.error || "ok"}`);
  }
  const ok = out[0] === "200:ok" && out.slice(1, 10).every(x => x === "429:rename_cooldown") && out[10] === "429:rate_limited" && out[11] === "429:rate_limited";
  row("R2", "12 renames, one IP, one token (limit 10/h per IP, cooldown 24h)", ok, out.join(" "));
}
if (phase === "caps") {
  const s = [];
  for (let i = 0; i < 305; i++) s.push((await post("/register", { username: `cap${tag}${i}`, key: GOOD }, `172.${16 + (i >> 8)}.${i & 255}.7`)).status);
  const n200 = s.filter(x => x === 200).length, f429 = s.indexOf(429) + 1;
  row("C1", "305 registrations from 305 distinct IPs (MAX_REG_PER_DAY=300; 1 already used by R2)", n200 === 299 && f429 === 300, `200 x${n200}, first 429 at attempt ${f429}, 429 x${s.filter(x => x === 429).length}`);
}
if (phase === "persistA") {
  const a = []; for (let i = 0; i < 15; i++) a.push((await post("/login", { login: `nobody${tag}`, key: BAD }, IPX)).status);
  const b = []; for (let i = 0; i < 7; i++) b.push((await post("/login", { login: `cap${tag}0`, key: BAD }, `192.0.2.${i + 1}`)).status);
  console.log(`INFO | persistA | 15 unknown-login failures from ${IPX}: ${a.join(",")} | 7 wrong-pw on cap${tag}0 from 7 IPs: ${b.join(",")}`);
}
if (phase === "persistB") {
  const a = []; for (let i = 0; i < 6; i++) a.push((await post("/login", { login: `nobody${tag}`, key: BAD }, IPX)).status);
  const b = []; for (let i = 0; i < 4; i++) b.push((await post("/login", { login: `cap${tag}0`, key: BAD }, `192.0.2.${i + 20}`)).status);
  row("P1", "IP failure counter survives a workerd restart (15 before + 6 after, limit 20)", a.indexOf(429) === 5 && a.slice(0, 5).every(x => x === 401), a.join(","));
  row("P2", "account failure counter survives a workerd restart (7 before + 4 after, limit 10)", b.indexOf(429) === 3 && b.slice(0, 3).every(x => x === 401), b.join(","));
}
