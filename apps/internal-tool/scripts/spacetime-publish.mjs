#!/usr/bin/env node
// Cross-platform SpacetimeDB publish that injects the allowed-issuers/audience
// auth config, publishes, and always restores the original file — even on
// failure.

import { spawnSync } from "node:child_process";

const target = process.argv[2]; // "local" or "prod"

const DEFAULT_DB_NAME = "hexclave-ai-analytics";
function resolveDbName() {
  const value = (process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME ?? "").trim();
  if (value === "" || value === "REPLACE_ME") return DEFAULT_DB_NAME;
  return value;
}
const dbName = resolveDbName();

/** HTTP API for 'spacetime publish' (matches docker/dependencies/docker.compose.yaml host port ...39). */
function localPublishServerUrl() {
  const publishUrl = process.env.HEXCLAVE_SPACETIME_PUBLISH_URL;
  if (publishUrl) {
    return publishUrl;
  }
  const prefix = process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81";
  return `http://127.0.0.1:${prefix}39`;
}

const configs = {
  local: [
    "publish",
    dbName,
    "--server",
    localPublishServerUrl(),
    "-p",
    "spacetimedb",
    "--yes",
    "--no-config",
    "--delete-data=on-conflict",
  ],
  prod: ["publish", dbName, "--server", "maincloud", "-p", "spacetimedb", "--no-config"],
};

const args = configs[target];
if (!args) {
  console.error("Usage: node scripts/spacetime-publish.mjs <local|prod>");
  process.exit(1);
}

if (target === "prod" && !process.env.HEXCLAVE_SPACETIMEDB_ALLOWED_ISSUERS && !process.env.HEXCLAVE_INTERNAL_TOOL_BASE_URL) {
  console.error("Error: HEXCLAVE_INTERNAL_TOOL_BASE_URL must be set for prod publish");
  process.exit(1);
}
const LOCAL_PUBLISH_TIMEOUT_MS = 60_000;

let exitCode = 1;
try {
  const inject = spawnSync("node", ["scripts/spacetime-auth-config.mjs", "inject"], { stdio: "inherit" });
  if (inject.status !== 0) {
    exitCode = inject.status ?? 1;
  } else {
    const publish = spawnSync("spacetime", args, {
      stdio: "inherit",
      ...(target === "local" ? { timeout: LOCAL_PUBLISH_TIMEOUT_MS } : {}),
    });
    if (publish.error?.code === "ETIMEDOUT") {
      console.error(`[spacetime-publish] 'spacetime publish' did not finish within ${LOCAL_PUBLISH_TIMEOUT_MS / 1000}s and was killed. The SpacetimeDB container may be unresponsive — try 'pnpm restart-deps'.`);
    }
    // On timeout (or any kill-by-signal) status is null, which maps to 1 here.
    exitCode = publish.status ?? 1;
  }
} finally {
  const restore = spawnSync("node", ["scripts/spacetime-auth-config.mjs", "restore"], { stdio: "inherit" });
  if (restore.status !== 0 && exitCode === 0) {
    exitCode = restore.status ?? 1;
  }
  process.exitCode = exitCode;
}
