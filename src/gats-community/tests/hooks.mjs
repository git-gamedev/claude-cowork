export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}', shortCircuit: true };
  }
  return next(spec, ctx);
}
