#!/usr/bin/env node
// Runs before `next dev`. Publishes the SpacetimeDB module to the local server
// if the spacetime CLI is installed. Otherwise, warns and continues so the dev
// server still starts (useful in CI and for contributors who haven't installed
// the CLI yet).
//
// No token provisioning is needed: this app is the OIDC issuer for
// SpacetimeDB tokens (it serves the discovery document + JWKS, mints tokens
// for signed-in users, and mints its own service tokens for telemetry
// ingested from the backend over HTTP). SpacetimeDB validates tokens via
// OIDC discovery against this app's dev server (reachable from the container
// through the spacetimedb-issuer-proxy sidecar in docker/dependencies).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const ENV_LOCAL = resolve(".env.local");
const SIGNING_SEED_VAR = "HEXCLAVE_SPACETIMEDB_SIGNING_SEED";

function ensureSigningSeed() {
  const existing = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
  const line = existing.split(/\r?\n/).filter((l) => l.startsWith(`${SIGNING_SEED_VAR}=`)).at(-1);
  const value = line ? line.slice(SIGNING_SEED_VAR.length + 1).trim() : "";
  if (value !== "" && value !== "REPLACE_ME") return;

  const seed = randomBytes(32).toString("base64url");
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(
    ENV_LOCAL,
    `${prefix}# Auto-generated per-developer SpacetimeDB signing seed (gitignored; do not commit or reuse in prod).\n${SIGNING_SEED_VAR}=${seed}\n`,
    "utf8",
  );
  console.log(`[internal-tool] Generated a local SpacetimeDB signing seed in .env.local`);
}

ensureSigningSeed();

const which = spawnSync(process.platform === "win32" ? "where" : "which", ["spacetime"], {
  stdio: "ignore",
});

if (which.status !== 0) {
  console.warn("\n[internal-tool] spacetime CLI not found, skipping publish.");
  console.warn("[internal-tool] To install it: curl -sSf https://install.spacetimedb.com | sh\n");
  process.exit(0);
}

const publish = spawnSync("pnpm", ["spacetime:publish:local"], {
  stdio: "inherit",
});

if (publish.status !== 0) {
  console.warn(`[internal-tool] spacetime publish failed (status ${publish.status}).`);
  process.exit(0);
}
