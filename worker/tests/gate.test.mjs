// Run: node --test tests/gate.test.mjs      (Node 20+)
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { Gate, ipKey } = await import('../src/gate.js');

// Minimal fake of a Durable Object's storage; `evict()` simulates a fresh instance over the same storage.
function makeStore() {
  const data = new Map(); let alarm = null;
  return { data, get alarm() { return alarm; },
    storage: { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); }, deleteAll: async () => data.clear(),
      setAlarm: async (t) => { alarm = t; } } };
}
const call = async (g, path, limit = 3, win = 900) => {
  const r = await g.fetch(new Request(`https://gate${path}?limit=${limit}&win=${win}`));
  return { status: r.status, ...(await r.json()) };
};

test('ipKey: IPv4 unchanged, IPv6 collapses to /64, mapped v4 handled', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:0db8:0001:0002::1'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(ipKey(undefined), 'unknown');
});

test('/fail counts, locks at the limit, and stops writing once locked', async () => {
  const s = makeStore(); const g = new Gate({ storage: s.storage }, {});
  assert.equal((await call(g, '/fail')).status, 200);
  assert.equal((await call(g, '/fail')).status, 200);
  const third = await call(g, '/fail');
  assert.equal(third.locked, true);
  const before = JSON.stringify(s.data.get('r'));
  assert.equal((await call(g, '/fail')).status, 429);
  assert.equal(JSON.stringify(s.data.get('r')), before, 'no writes while locked');
  assert.equal((await call(g, '/check')).locked, true);
});

test('counts survive eviction (new instance, same storage)', async () => {
  const s = makeStore();
  await call(new Gate({ storage: s.storage }, {}), '/fail');
  await call(new Gate({ storage: s.storage }, {}), '/fail');
  const fresh = new Gate({ storage: s.storage }, {});
  assert.equal((await call(fresh, '/check')).n, 2);
  assert.equal((await call(fresh, '/fail')).locked, true);
});

test('/ok clears the counter; /hit locks at limit with 429', async () => {
  const s = makeStore(); const g = new Gate({ storage: s.storage }, {});
  await call(g, '/fail'); await call(g, '/ok');
  assert.equal((await call(g, '/check')).n, 0);
  for (let i = 0; i < 3; i++) assert.equal((await call(g, '/hit')).status, 200);
  assert.equal((await call(g, '/hit')).status, 429);
});

test('window expiry resets the count; alarm removes the row', async () => {
  const s = makeStore(); const g = new Gate({ storage: s.storage }, {});
  await call(g, '/fail', 3, 900);
  g.rec = { n: 2, reset: Date.now() - 1 }; s.data.set('r', g.rec);        // pretend the window ended
  assert.equal((await call(g, '/check')).n, 0);
  await g.alarm();
  assert.equal(s.data.size, 0);
});

test('/try reserves slots atomically: only `limit` parallel tries pass; /done releases, /fail consumes', async () => {
  const s = makeStore(); const g = new Gate({ storage: s.storage }, {});
  const rs = await Promise.all(Array.from({ length: 10 }, () => call(g, '/try', 3)));
  assert.equal(rs.filter((r) => r.status === 200).length, 3);
  assert.equal(rs.filter((r) => r.status === 429).length, 7);
  await call(g, '/done', 3);                                   // one attempt finished without failing
  assert.equal((await call(g, '/try', 3)).status, 200);        // its slot is free again
  assert.equal((await call(g, '/try', 3)).status, 429);
  for (let i = 0; i < 3; i++) await call(g, '/fail', 3);       // three failures consume the reservations
  assert.equal((await call(g, '/check', 3)).locked, true);
  assert.equal((await call(g, '/try', 3)).status, 429);
});

test('/try reservations expire so a crashed request cannot hold a slot forever', async () => {
  const s = makeStore(); const g = new Gate({ storage: s.storage }, {});
  assert.equal((await call(g, '/try', 1)).status, 200);
  assert.equal((await call(g, '/try', 1)).status, 429);
  g.pending = g.pending.map(() => Date.now() - 60000);         // simulate a leaked reservation older than the TTL
  assert.equal((await call(g, '/try', 1)).status, 200);
});
