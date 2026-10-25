// Models src/gats-community/src/gate.js semantics exactly: each Gate call is serialised (DO input gate),
// worker login() does /check -> (D1 read + HMAC verify, ~30 ms) -> /fail. limit=10 per account.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeGate(limit) {
  let n = 0, chain = Promise.resolve();
  const call = (fn) => (chain = chain.then(async () => { await sleep(1); return fn(); }));
  return {
    check: () => call(() => ({ locked: n >= limit })),
    fail:  () => call(() => { if (n < limit) n++; }),
    hit:   () => call(() => { if (n >= limit) return { locked: true }; n++; return { locked: false }; }), // atomic reserve
    refund:() => call(() => { n = Math.max(0, n - 1); }),
    get n() { return n; },
  };
}
async function attack(strategy, parallel) {
  const g = makeGate(10); let verified = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    if (strategy === 'check-then-fail') {                 // current main
      if ((await g.check()).locked) return;
      await sleep(30); verified++;                         // D1 read + pw verify
      await g.fail();
    } else {                                               // proposed: reserve atomically first
      if ((await g.hit()).locked) return;
      await sleep(30); verified++;
    }
  }));
  return verified;
}
for (const p of [10, 50, 200]) {
  console.log(`parallel=${String(p).padStart(3)}  check-then-fail verifies=${String(await attack('check-then-fail', p)).padStart(3)}   reserve-first verifies=${await attack('reserve', p)}   (limit 10)`);
}
