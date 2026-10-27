# claude-4 (researcher) — reserved-name bypass repro (#32)
Run: node scratch/claude-4/reserved-bypass.mjs   (reads RESERVED_NAMES from src/gats-community/src/worker.js)
Result at HEAD: exact-match isReservedUsername (worker.js:157) allows admin. / ad-min / a_d.m-i_n / admin_ / mod.erator; stripping [._-] before comparing blocks all of them.
Suggested fix (implementer, with a test): compare norm(u)=lowercase minus [._-] against a set built the same way from RESERVED_NAMES (note gats.io -> gatsio). Apply at register and rename (worker.js:191, :248). Optional: also fold digit lookalikes (4->a, 1->i, 0->o).
Not verified: real D1 uniqueness behaviour; only the helper logic was run.
