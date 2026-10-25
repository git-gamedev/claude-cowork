export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: new URL("./cf-stub.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
