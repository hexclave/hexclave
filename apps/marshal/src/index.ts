// Vercel's Elysia preset finds the entrypoint by scanning known paths (src/index.ts among them)
// for a file that imports the `elysia` package and default-exports the app — see
// https://vercel.com/docs/frameworks/backend/elysia#entrypoint-detection. The bare import below
// exists only to satisfy that scan.
import "elysia";
// Import the built artifact rather than ./vercel, for the same reason apps/backend does: the
// deployed function then runs the exact tsdown bundle that `pnpm build` produces and CI
// typechecks, instead of an artifact Vercel's own bundler recompiles from workspace source
// (which would have to resolve marshal's NodeNext-style `./x.js` specifiers itself). The Vercel
// build command runs `pnpm run build` before function bundling, so dist/vercel.mjs exists by
// this point. Nothing else imports this file: the standalone listener is src/server.ts.
import app from "../dist/vercel.mjs";

// Vercel's native Elysia builder delegates to the Node builder, which statically reads this
// exact exported object. Its parser requires a numeric literal here.
//
// A service apply (PUT /v1/namespaces/:ns/services/:key) holds the reconciliation lease while it
// converges GCP resources and polls runtime state, so it is
// not a sub-minute request. Builds themselves do not count against this: they run on a separate
// builder VM and report back over the completion webhook, long after the apply has responded.
export const config = {
  maxDuration: 800,
};

export default app;
