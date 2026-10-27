// TEST-ONLY wrapper: captures mail codes instead of calling Resend. Not part of src/.
import w, { Room, Gate, Verifier } from "./src/worker.js";
export { Room, Gate, Verifier };
const mails = [];
export default { fetch(req, env, ctx) {
  const u = new URL(req.url);
  if (u.pathname === "/__mails") return Response.json(mails);
  return w.fetch(req, { ...env, MAILER: (to, code) => { mails.push({ to, code }); } }, ctx);
} };
