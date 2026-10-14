// These packages rely on their physical node_modules layout at runtime and must not be
// folded into the application bundle. In particular, Sentry registers an ESM loader
// relative to its own package so that import-in-the-middle resolves to Sentry's declared
// version and so Vercel's file tracer can follow its static runtime dependency graph.
export const backendRuntimeExternalPackages: readonly string[] = [
  "@prisma/client",
  "@prisma/adapter-neon",
  "@prisma/adapter-pg",
  "@prisma/instrumentation",
  "@prisma/extension-read-replicas",
  "@prisma/client/runtime/library",
  "@prisma/client/runtime/client",
  "@prisma/client/runtime/edge",
  "@sentry/node",
  // Loads the native pprof addon via `bindings`, which resolves the .node file relative to the
  // package directory, so it can't be folded into the bundle either.
  "@google-cloud/profiler",
  "bcrypt",
  "oidc-provider",
  "pg",
  "sharp",
  // @aws-sdk and @smithy use complex class hierarchies that rolldown mis-scopes
  // when bundled, emitting references to hoisted classes before they're defined
  // (e.g. "ReferenceError: StructureSchema$1 is not defined" when the server
  // bundle boots via `node dist/server.mjs`). Keep them external so Node resolves
  // them from node_modules at runtime, which is always present alongside the
  // bundle (Docker image, CI runner, Vercel NFT trace). Mirrors the same fix in
  // db-migrations.tsdown.config.ts.
  "@aws-sdk",
  "@smithy",
];

export function isBackendRuntimeExternalPackage(specifier: string) {
  return backendRuntimeExternalPackages.some(
    (externalPackage) => specifier === externalPackage || specifier.startsWith(`${externalPackage}/`),
  );
}
