// Real-workerd checks for scenario F (#31): sequential IP gate threshold + parallel burst (TOCTOU).
// Usage: node burst.mjs  (wrangler dev --local on :8788 with TOKEN_SECRET/PEPPER/ADMIN_KEY in .dev.vars)
const BASE = 'http://localhost:8788';
const post = (p, b, ip) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(b) });
const tally = (arr) => arr.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
const good = 'C'.repeat(43), bad = 'B'.repeat(43);
const run = Date.now().toString(36);

// 1. sequential: unknown login from one IP -> when does 429 start? (config: IP limit 20/900s)
{
  const st = [];
  for (let i = 0; i < 25; i++) st.push((await post('/login', { login: 'nouser' + run, key: bad }, '9.1.1.1')).status);
  console.log('seq unknown-user, one IP, 25 tries:', st.join(','), '| first 429 at try', st.indexOf(429) + 1);
}
// 2. parallel burst, many IPs, ONE existing account (account limit 10/900s)
{
  const name = 'victim' + run;
  const r = await post('/register', { username: name, key: good }, '7.7.7.7'); console.log('register', r.status);
  const N = 200;
  const res = await Promise.all(Array.from({ length: N }, (_, i) => post('/login', { login: name, key: bad }, `20.${i >> 8}.${i & 255}.1`).then(x => x.status)));
  console.log(`parallel ${N} wrong-password guesses, distinct IPs, one account:`, JSON.stringify(tally(res)), '(limit 10 => ideal 10x401, rest 429)');
  const after = await post('/login', { login: name, key: good }, '30.0.0.1');
  console.log('owner correct login from fresh IP right after burst:', after.status);
}
// 3. parallel burst, ONE IP, unknown users (IP limit 20/900s)
{
  const N = 200;
  const res = await Promise.all(Array.from({ length: N }, (_, i) => post('/login', { login: 'u' + i + run, key: bad }, '9.2.2.2').then(x => x.status)));
  console.log(`parallel ${N} guesses, one IP, unknown users:`, JSON.stringify(tally(res)), '(limit 20 => ideal 20x401, rest 429)');
}
