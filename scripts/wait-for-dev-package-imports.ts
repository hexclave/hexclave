/// <reference types="node" />

import { spawn } from "child_process";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

// Root `pnpm run dev` starts eager generators and package watch builds in
// parallel. `generate-openapi-docs:watch` intentionally runs `codegen-docs`
// once before starting chokidar, because chokidar only responds to future file
// changes. Without that initial run, dev docs could serve stale OpenAPI JSON
// from a previous branch, or no generated JSON at all after a clean checkout,
// until someone edits an API route.
//
// That eager OpenAPI generation imports backend modules, and some of those
// backend modules resolve workspace packages through their built `dist`
// entrypoints. Package watch scripts update those entrypoints with
// `tsdown --watch`, but on a cold checkout, after `pnpm clean`, or during the
// first package watcher build, the entrypoints may not exist yet even though
// `tsdown --watch` is about to create them.
//
// We keep this wait scoped to the eager generator rather than putting it in
// front of backend `dev`: the long-running Next dev server can tolerate package
// watchers warming up, while a one-shot generator exits immediately on a missing
// import and `concurrently -k` then tears down the whole dev command. Package
// watch scripts also avoid deleting `dist` in dev mode, which removes the
// common restart race; this probe covers the remaining cold-start case.
//
// This probe waits only for the package imports that the backend-side generator
// needs. It does not hide real runtime errors: we retry missing-module failures
// while package builds warm up, and fail immediately for other import failures.
//
// In addition to workspace packages, the probe checks that the generated Prisma
// client is actually importable. When `turbo run dev` starts the backend,
// `codegen-prisma:watch` (`prisma generate --watch`) rewrites
// `src/generated/prisma/` in place, so individual files can exist while the
// module graph is still incomplete. An existence check on one file treats that
// window as ready, then `codegen-docs` dies with ERR_MODULE_NOT_FOUND. So the
// probe (a) imports the real client entrypoint, which fails retryably while any
// file of its graph is missing, and (b) requires the generated tree to have
// been quiet for a moment, so a pass cannot land in the middle of a rewrite
// burst. Neither guard can prove the initial `prisma generate` of THIS dev run
// already happened (on a warm checkout the committed output is importable and
// quiet before the generator even starts), which is why the caller retries the
// eager `codegen-docs` once — see `generate-openapi-docs:watch`.
const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, "apps/backend");
const timeoutMs = 60_000;
const retryDelayMs = 1_000;

const probeScript = `
(async () => {
  await import('@hexclave/js');
  await import('@hexclave/shared/dist/utils/env');
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const prismaDir = join(process.cwd(), 'src', 'generated', 'prisma');
  // Importing the entrypoint pulls the full generated graph through tsx, so a
  // half-written tree fails here with a retryable module-not-found.
  await import(pathToFileURL(join(prismaDir, 'client.ts')).href);
  // Reject a pass while the generator is mid-burst: prisma writes the whole
  // tree in quick succession, so any file younger than the window means a
  // rewrite is (likely still) in progress.
  const quietWindowMs = 1500;
  const newestMtimeMs = (dir) => {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtimeMs(entryPath));
      } else {
        newest = Math.max(newest, statSync(entryPath).mtimeMs);
      }
    }
    return newest;
  };
  const age = Date.now() - newestMtimeMs(prismaDir);
  if (age < quietWindowMs) {
    const err = new Error('ERR_MODULE_NOT_FOUND: Generated Prisma client was rewritten ' + Math.round(age) + 'ms ago; waiting for the generator to settle at ' + prismaDir);
    throw err;
  }
})().then(
  () => undefined,
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
`;

type ProbeResult = {
  exitCode: number | null,
  output: string,
};

function runProbe(): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "-e", probeScript], {
      cwd: backendDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, output });
    });
  });
}

function isMissingModuleError(output: string) {
  return output.includes("ERR_MODULE_NOT_FOUND") || output.includes("MODULE_NOT_FOUND");
}

async function main() {
  const start = performance.now();
  let lastOutput = "";
  let hasLoggedWait = false;
  let isReady = false;

  while (performance.now() - start < timeoutMs) {
    const result = await runProbe();
    if (result.exitCode === 0) {
      isReady = true;
      break;
    }

    lastOutput = result.output;
    if (!isMissingModuleError(result.output)) {
      throw new Error(`Dev package import probe failed with a non-retryable error:\n${result.output}`);
    }

    if (!hasLoggedWait) {
      console.log("Waiting for dev package entrypoints to be generated...");
      hasLoggedWait = true;
    }
    await sleep(retryDelayMs);
  }

  if (!isReady) {
    throw new Error(`Timed out waiting for dev package imports to become available. Last probe output:\n${lastOutput}`);
  }
}

main().then(
  () => undefined,
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
