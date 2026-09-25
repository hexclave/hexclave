#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeStandaloneSwcHelpers } from "./complete-standalone-swc-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(scriptDir, "..");
const distDir = process.env.HEXCLAVE_DASHBOARD_NEXT_DIST_DIR ?? ".next-development-environment";
const nextOutputRoot = resolve(dashboardRoot, distDir);
const standaloneRoot = join(nextOutputRoot, "standalone");
const standaloneDashboardRoot = join(standaloneRoot, "apps", "dashboard");
const standaloneServerPath = join(standaloneDashboardRoot, "server.js");

function runOrExit(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: "inherit",
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return;
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

runOrExit("pnpm", ["run", "bundle-type-definitions"]);
runOrExit("pnpm", ["exec", "next", "build"], {
  env: {
    NEXT_CONFIG_OUTPUT: "standalone",
    NODE_ENV: "production",
    STACK_NEXT_CONFIG_DISABLE_TYPESCRIPT: "true",
    HEXCLAVE_DASHBOARD_BUILD_FOR_RDE: "true",
  },
});

if (!existsSync(standaloneServerPath)) {
  throw new Error(`Dashboard standalone server was not created at ${standaloneServerPath}.`);
}

completeStandaloneSwcHelpers(standaloneRoot, resolve(dashboardRoot, "../../node_modules/.pnpm"));

copyIfExists(join(nextOutputRoot, "static"), join(standaloneDashboardRoot, distDir, "static"));
copyIfExists(join(dashboardRoot, "public"), join(standaloneDashboardRoot, "public"));

const server = spawn(process.execPath, [standaloneServerPath], {
  cwd: standaloneDashboardRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    // `next.config`'s `headers()` is evaluated at build time and baked into the
    // routes manifest (the build above already sets this flag), so the RDE
    // frame-ancestors headers are correct regardless of the server's runtime
    // env. We still propagate the flag here so the running process self-reports
    // as an RDE build and stays correct if any header logic ever moves to runtime.
    HEXCLAVE_DASHBOARD_BUILD_FOR_RDE: "true",
  },
  stdio: "inherit",
});

function stopServer(signal) {
  if (!server.killed) {
    server.kill(signal);
  }
}

process.on("SIGINT", () => stopServer("SIGINT"));
process.on("SIGTERM", () => stopServer("SIGTERM"));

server.on("exit", (code, signal) => {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  process.exit(code ?? 1);
});

server.on("error", (error) => {
  throw error;
});
