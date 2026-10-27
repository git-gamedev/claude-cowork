// Replays synthetic gats.io frames through MODULE 4 of gats-community.user.js. Run: node userscript/replay.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL("./gats-community.user.js", import.meta.url), 'utf8');
const code = src.slice(src.indexOf('(function hook_handler()'));

// ---- stubs mirroring the real dispatcher (observer -> transformer per frame, then batchComplete) ----
let observer, transformer, batchDone, closeFn, handlers;
const sent = { lookups: [], hello: [] };
let loggedIn = true, open = true;
const GCL = {
  events: new EventTarget(),
  ws: {
    onEveryFrame: (f) => { observer = f; },
    addFrameTransformer: (f) => { transformer = f; },
    onBatchComplete: (f) => { batchDone = f; },
    onSocketClose: (f) => { closeFn = f; },
    getCurrentServerUrl: () => 'wss://us-east.gats.io:443/',
  },
  presence: {
    setRoom() {}, bye() {}, isOpen: () => open,
    hello: (...a) => sent.hello.push(a), lookup: (ids) => sent.lookups.push(ids),
    setHandlers: (h) => { handlers = h; },
  },
  auth: { isLoggedIn: () => loggedIn, getUser: () => ({ username: 'MyComm' }) },
};
new Function('GCL', 'window', code)(GCL, { addEventListener() {} });

function feed(text) {
  const frames = text.split('|');
  const out = frames.map((fr, i) => {
    observer(fr, { frame_id: i, total_frames: frames.length });
    return transformer(fr, { frame_id: i, total_frames: frames.length });
  });
  batchDone();
  return out.join('|');
}

const A = (id, name) => ['a', id, 0, 0, 0, 0, 20, 0, 0, 10, 10, 0, 100, 800, 600, 100, 5000, 5000, name, 0, 0, 0, 0, name].join(',');
const D = (id, name) => ['d', id, 1, 3, 100, 100, 20, 0, 0, 100, 10, name, 0, 0, 0, 0, 0, 0].join(',');
const C = (id, { r = 20, color = 3, msg = '' } = {}) => ['c', id, 10, 0, 0, 100, 0, 0, r, 0, 10, 0, 0, 0, 0, color, msg].join(',');
const results = [];
const t = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };

feed(A('1', 'Me'));

t('b/c frames for unknown ids create nothing and inject nothing', () => {
  const out = feed('b,99,1,2,3,4,5|' + C('99'));
  assert.equal(out, 'b,99,1,2,3,4,5|' + C('99'));
});

t('claim with matching gname swaps name, injects d+c once status known', () => {
  feed(D('7', 'guestA'));
  feed(C('7'));
  handlers.join({ pid: '7', name: 'Alice', gname: 'guestA' });
  const out = feed('b,7,1,1,0,0,0');
  const inj = out.split('|').slice(1);
  assert.equal(inj.length, 2, 'expected d+c injection, got: ' + out);
  assert.equal(inj[0].split(',')[11], 'Alice');
});

t('gname mismatch is rejected (no injection)', () => {
  feed(D('8', 'guestB')); feed(C('8'));
  handlers.join({ pid: '8', name: 'Eve', gname: 'someoneElse' });
  assert.equal(feed('b,8,1,1,0,0,0'), 'b,8,1,1,0,0,0');
});

t('sparse c frame (blank fields) does not wipe radius/color in later rebuild', () => {
  feed(D('9', 'guestC')); feed(C('9', { r: 25, color: 4 }));
  feed('c,9,,,,,,,,,,,,,,,'); // all blank = unchanged
  handlers.join({ pid: '9', name: 'Cara', gname: 'guestC' });
  const inj = feed('b,9,1,1,0,0,0').split('|').slice(1);
  assert.equal(inj[0].split(',')[6], '25');
  assert.equal(inj[0].split(',')[3], '4');
});

t('rename rebuild must NOT replay an old chat bubble', () => {
  feed(D('10', 'guestD')); feed(C('10'));
  handlers.join({ pid: '10', name: 'Dan', gname: 'guestD' });
  feed('b,10,0,0,0,0,0');                       // flush first injection
  feed(C('10', { msg: 'hello there' }));         // player says something
  feed(C('10'));                                 // later frame: no message
  handlers.rename({ pid: '10', name: 'Dan2', gname: 'guestD' });
  const inj = feed('b,10,0,0,0,0,0').split('|').slice(1);
  const cframe = inj.find((x) => x.startsWith('c,'));
  assert.ok(cframe, 'no injected c frame: ' + inj.join(' / '));
  assert.equal(cframe.split(',')[16], '', 'injected c frame replays old chat: ' + cframe);
});

t('own a-frame gets community name in fields 18 and 23', () => {
  const out = feed(A('1', 'Me')).split(',');
  assert.equal(out[18], 'MyComm'); assert.equal(out[23], 'MyComm');
});

t('hello reports the ORIGINAL in-game name as gname (not the community name)', () => {
  feed(A('1', 'Me'));
  assert.deepEqual(sent.hello.at(-1), ['1', 'Me']);
});

t('lookups are throttled and capped per ghost', () => {
  sent.lookups.length = 0;
  feed(D('20', 'g20'));
  for (let i = 0; i < 6; i++) feed('b,20,0,0,0,0,0');
  assert.ok(sent.lookups.length <= 1, 'lookups fired ' + sent.lookups.length + ' times in one tick');
});

t('e frame clears claim; pid reuse with a different name is not mislabeled', () => {
  feed(D('30', 'old')); feed(C('30'));
  handlers.join({ pid: '30', name: 'OldComm', gname: 'old' });
  feed('e,30'); feed(D('30', 'newguy')); feed(C('30'));
  assert.equal(feed('b,30,0,0,0,0,0'), 'b,30,0,0,0,0,0');
});

for (const r of results) console.log(r.join(' | '));
process.exitCode = results.some((r) => r[0] === 'FAIL') ? 1 : 0;
