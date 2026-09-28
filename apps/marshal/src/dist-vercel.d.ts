// src/index.ts (the Vercel entrypoint) intentionally imports the tsdown build artifact, which
// doesn't exist at typecheck time and ships no types. Ambient module declarations can't match
// relative specifiers, hence the wildcard pattern.
declare module "*/dist/vercel.mjs" {
  import type { Elysia } from "elysia";

  const app: Elysia;
  export default app;
}
