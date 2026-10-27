SHA tested: f6579e0 (src/gats-community/src/worker.js). Run via Node, logic extracted verbatim from worker.js (not workerd).

| id | scenario | how run | result | notes |
|----|----------|---------|--------|-------|
| B-reserved | reserved-name variants | node scratch/sonnet/reserved-repro.mjs | FAIL | exact lowercase Set match only; 20 of 24 variants pass USERNAME_RE and are accepted |

Accepted variants include: admin. admin_ admin- .admin ad-min ad.min a.d.m.i.n adm1n admin1 gats_io gats-io gatsio m0derator moderator. st-aff 0wner supp0rt r00t system.
Blocked correctly: admin Admin ADMIN gats.io.
Suggested fix (not applied, role is researcher): normalize before lookup (lowercase, strip . _ -, map 0->o 1->i/l 3->e 5->s), then compare against normalized reserved set; consider prefix/suffix match for admin|mod|staff.
