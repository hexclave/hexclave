// The no-listen entry: the hosting platform owns the listener and hands each request to the
// exported app. Built by tsdown into dist/vercel.mjs, which src/index.ts (Vercel's detected
// entrypoint) re-exports.
//
// Deliberately does NOT import ./load-env: on a hosted deployment the platform's environment
// is the only source of configuration, and the committed .env / .env.development files are
// dev/mock defaults that must never be a fallback for a production process. Configuration is
// read at import time (createMarshalApp calls getConfig), so a missing or unsafe variable
// fails the function's cold start with marshal's own message instead of failing per request.
//
// Deliberately does NOT start any background work here either. Import-time fire-and-forget
// is a lie on this platform: the sandbox is frozen when the response is written, so the pool
// top-up that used to start here never finished and leaked a billed project each time. The
// pool is advanced by the crons in vercel.json instead — see src/project-pool.ts.
import { createMarshalApp } from "./marshal-app.js";

const { app } = createMarshalApp();

export default app;
