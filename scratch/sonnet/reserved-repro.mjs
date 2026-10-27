// Extracts RESERVED_NAMES / USERNAME_RE / isReservedUsername verbatim from worker.js and probes variants.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../src/gats-community/src/worker.js', import.meta.url), 'utf8');
const grab = (re) => src.match(re)[0];
const code = [
  grab(/const USERNAME_RE = .*;/),
  grab(/const RESERVED_NAMES = new Set\(\[[\s\S]*?\]\);/),
  grab(/const isReservedUsername = .*;/),
  'return {USERNAME_RE, isReservedUsername};'
].join('\n');
const { USERNAME_RE, isReservedUsername } = new Function(code)();
const variants = ['admin','Admin','ADMIN','admin.','admin_','admin-','.admin','_admin','ad-min','ad.min','ad_min','a.d.m.i.n','adm1n','admin1','gats.io','gats_io','gats-io','gatsio','m0derator','moderator.','st-aff','0wner','supp0rt','r00t','system.'];
console.log('variant | passes USERNAME_RE | reserved-blocked | ACCEPTED');
for (const v of variants) {
  const ok = USERNAME_RE.test(v), blocked = isReservedUsername(v);
  console.log(v.padEnd(12), ok, blocked, ok && !blocked ? 'ACCEPTED' : '');
}
