import { webcrypto as crypto } from 'node:crypto';
const BASE = 'http://localhost:8787', WS = 'ws://localhost:8787';
const enc = new TextEncoder();
const b64u = (u8) => Buffer.from(u8).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
async function ph(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array([...enc.encode('gcl-v1|'), ...unb64u(saltB64)]);
  return b64u(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
}
async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
let fails = 0;
const ok = (c, m, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + JSON.stringify(extra))); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function signup(name, pw) {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  return post('/signup', { username: name, salt, ph: await ph(pw, salt, 250000), iter: 250000 });
}
async function login(name, pw) {
  const s = await post('/login/salt', { username: name });
  if (s.status !== 200) return s;
  return post('/login', { username: name, ph: await ph(pw, s.data.salt, s.data.iter) });
}

// ---- HTTP flows
let r = await signup('Alice', 'correct horse battery');
ok(r.status === 201 && r.data.token, 'signup alice', r);
const alice = r.data;
r = await signup('alice', 'x'.repeat(10)); ok(r.status === 409 && r.data.error === 'username_taken', 'duplicate (case-insens) rejected', r);
r = await signup('a b', 'x'); ok(r.status === 400, 'bad username rejected', r);
r = await login('ALICE', 'correct horse battery'); ok(r.status === 200 && r.data.user.username === 'Alice', 'login case-insensitive', r);
r = await login('Alice', 'wrong'); ok(r.status === 401 && r.data.error === 'invalid_credentials', 'wrong pw 401', r);
r = await login('Nobody', 'whatever'); ok(r.status === 401 && r.data.error === 'invalid_credentials', 'unknown user 401', r);
const s1 = await post('/login/salt', { username: 'Nobody' }), s2 = await post('/login/salt', { username: 'Nobody' });
ok(s1.data.salt === s2.data.salt && s1.data.salt.length === 22, 'fake salt stable + well-formed', s1);

// lockout: 5 wrong -> 429
for (let i = 0; i < 4; i++) await login('Alice', 'wrong' + i);
r = await login('Alice', 'wrong-final'); // 5th failure total counted? (1 earlier + 4 = 5 -> locked after the 5th)
r = await login('Alice', 'correct horse battery');
ok(r.status === 429 && r.data.error === 'locked', 'locked after 5 failures (even with right pw)', r);

// second account for the rest
r = await signup('Bob', 'bobs password 123'); const bob = r.data; ok(r.status === 201, 'signup bob', r);

// rename
r = await post('/rename', { name: 'Bobby' }, bob.token); ok(r.status === 200 && r.data.user.username === 'Bobby', 'rename ok', r);
const bob2 = r.data;
r = await post('/rename', { name: 'Bobby2' }, bob2.token); ok(r.status === 429 && r.data.error === 'cooldown', 'rename cooldown', r);
r = await post('/rename', { name: 'bobby' }, alice.token); ok(r.status === 409 || r.status === 429, 'rename to taken name blocked', r);
r = await post('/rename', { name: 'Zed' }, 'garbage.token'); ok(r.status === 401, 'rename bad token 401', r);
r = await post('/rename', { name: 'Zed' }); ok(r.status === 401, 'rename no token 401', r);

// ---- presence
function connect(room, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/presence?room=${room}`, ['gcl.v1', token]);
    const inbox = []; const closes = [];
    ws.onmessage = (e) => inbox.push(e.data === 'pong' ? 'pong' : JSON.parse(e.data));
    ws.onclose = (e) => closes.push(e.code);
    ws.onerror = () => {};
    ws.onopen = () => resolve({ ws, inbox, closes });
    setTimeout(() => resolve({ ws, inbox, closes, timeout: true }), 4000);
  });
}
// carol/dave for presence
const carol = (await signup('Carol', 'carol password 1')).data, dave = (await signup('Dave', 'dave password 12')).data;
const room = 'eu1.gats.io:8443';
const C = await connect(room, carol.token); await sleep(300);
ok(C.inbox.some(m => m.t === 'hello' && m.name === 'Carol'), 'carol gets hello with D1 name', C.inbox);
C.ws.send('ping'); await sleep(300); ok(C.inbox.includes('pong'), 'ping -> pong auto response', C.inbox);
const D = await connect(room, dave.token); await sleep(300);
C.ws.send(JSON.stringify({ t: 'claim', gid: '17' })); await sleep(300);
ok(C.inbox.some(m => m.t === 'claimed' && m.gid === '17'), 'carol claimed 17', C.inbox);
ok(D.inbox.some(m => m.t === 'join' && m.gid === '17' && m.name === 'Carol'), 'dave got join broadcast', D.inbox);
D.ws.send(JSON.stringify({ t: 'claim', gid: '17' })); await sleep(300);
ok(D.inbox.some(m => m.t === 'claim_err' && m.reason === 'taken'), 'dave cannot steal gid 17', D.inbox);
D.ws.send(JSON.stringify({ t: 'claim', gid: '22' })); await sleep(200);
D.ws.send(JSON.stringify({ t: 'lookup', gids: ['17', '22', '99'] })); await sleep(300);
const names = D.inbox.filter(m => m.t === 'names').pop();
ok(names && names.names['17'] === 'Carol' && names.names['22'] === 'Dave' && !('99' in names.names), 'lookup resolves known, omits unknown', names);
// live rename push (bob not connected here; use carol's rename -> cooldown free since she never renamed)
r = await post('/rename', { name: 'CarolNew', room }, carol.token); ok(r.status === 200, 'carol rename with room', r);
await sleep(500);
ok(D.inbox.some(m => m.t === 'rename' && m.gid === '17' && m.name === 'CarolNew'), 'dave got live rename', D.inbox.filter(m=>m.t==='rename'));
// leave broadcast on close
C.ws.close(); await sleep(500);
ok(D.inbox.some(m => m.t === 'leave' && m.gid === '17'), 'dave got leave when carol disconnected', D.inbox.filter(m=>m.t==='leave'));
// bad tokens
let X = await connect(room, 'bad.token'); await sleep(400); ok(X.closes.includes(4401), 'bad token -> close 4401', X.closes);
// replacement
const D2 = await connect(room, dave.token); await sleep(400);
ok(D.closes.includes(4000) || D.inbox.some(m => m.t === 'replaced'), 'older dave socket told replaced', D.closes);
// no origin/room validation
let r2 = { status: Number((await import('node:child_process')).execSync(`curl -s -o /dev/null -w '%{http_code}' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Protocol: gcl.v1' '${BASE}/presence?room=BAD%20ROOM'`).toString())}; ok(r2.status === 400, 'bad room 400', r2);
r2 = await fetch(`${BASE}/presence?room=x`); ok(r2.status === 426, 'non-upgrade 426');
r2 = await fetch(`${BASE}/nope`); ok(r2.status === 404, '404 unknown');

// ban + revoke: bump version/ban in D1 directly, expect close on next sweep (needs REVALIDATE ttl elapsed) -> check HTTP paths instead
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
