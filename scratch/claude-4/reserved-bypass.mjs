// Repro: exact-match reserved-name check vs punctuation variants. Mirrors worker.js:157 logic.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../../src/gats-community/src/worker.js", import.meta.url), "utf8");
const m = src.match(/const RESERVED_NAMES = new Set\(\[([\s\S]*?)\]\)/);
const set = new Set([...m[1].matchAll(/[\x27\"]([^\x27\"]+)[\x27\"]/g)].map(x => x[1]));
const isReserved = (u) => set.has(String(u).toLowerCase());
const norm = (u) => String(u).toLowerCase().replace(/[._-]+/g, "");
const normSet = new Set([...set].map(norm));
const isReservedNorm = (u) => normSet.has(norm(u));
console.log("reserved entries:", [...set].join(","));
for (const t of ["admin","Admin","admin.","ad-min","a_d.m-i_n","admin_","moderator","mod.erator"]) {
  console.log(t.padEnd(12), "exact:", isReserved(t) ? "BLOCKED" : "allowed", "| normalized:", isReservedNorm(t) ? "BLOCKED" : "allowed");
}
