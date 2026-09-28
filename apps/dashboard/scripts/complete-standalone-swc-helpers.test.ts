import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeStandaloneSwcHelpers } from "./complete-standalone-swc-helpers.mjs";

const ESM_SENTINEL = join("esm", "_interop_require_default.js");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir != null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "standalone-swc-helpers-"));
  return tempDir;
}

function writeCjsOnlyHelpers(dir: string): void {
  mkdirSync(join(dir, "cjs"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@swc/helpers",
    version: "0.5.23",
    exports: {
      ".": {
        "module-sync": "./esm/index.js",
        default: "./cjs/index.cjs",
      },
    },
  }));
  writeFileSync(join(dir, "cjs", "_interop_require_default.cjs"), "module.exports = {};\n");
}

function writeCompleteHelpers(dir: string): void {
  writeCjsOnlyHelpers(dir);
  mkdirSync(join(dir, "esm"), { recursive: true });
  writeFileSync(join(dir, ESM_SENTINEL), "export default {};\n");
}

function helpersStorePath(root: string, version = "0.5.23"): string {
  return join(root, "node_modules", ".pnpm", `@swc+helpers@${version}`, "node_modules", "@swc", "helpers");
}

describe("completeStandaloneSwcHelpers", () => {
  it("replaces a CJS-only traced package with the complete repo copy", () => {
    const root = makeTempDir();
    const standaloneRoot = join(root, "standalone");
    const repoRoot = join(root, "repo");
    const repoPnpmRoot = join(repoRoot, "node_modules", ".pnpm");
    const dest = helpersStorePath(standaloneRoot);
    const src = helpersStorePath(repoRoot);

    writeCjsOnlyHelpers(dest);
    writeCompleteHelpers(src);

    expect(existsSync(join(dest, ESM_SENTINEL))).toBe(false);

    completeStandaloneSwcHelpers(standaloneRoot, repoPnpmRoot);

    expect(existsSync(join(dest, ESM_SENTINEL))).toBe(true);
  });

  it("is a no-op when the ESM sentinel is already present", () => {
    const root = makeTempDir();
    const standaloneRoot = join(root, "standalone");
    const repoPnpmRoot = join(root, "repo-pnpm");
    const dest = helpersStorePath(standaloneRoot);

    writeCompleteHelpers(dest);
    mkdirSync(repoPnpmRoot, { recursive: true });

    completeStandaloneSwcHelpers(standaloneRoot, repoPnpmRoot);

    expect(existsSync(join(dest, ESM_SENTINEL))).toBe(true);
  });

  it("throws when the repo store is missing the traced helpers version", () => {
    const root = makeTempDir();
    const standaloneRoot = join(root, "standalone");
    const repoPnpmRoot = join(root, "repo-pnpm");
    const dest = helpersStorePath(standaloneRoot);

    writeCjsOnlyHelpers(dest);
    mkdirSync(repoPnpmRoot, { recursive: true });

    expect(() => completeStandaloneSwcHelpers(standaloneRoot, repoPnpmRoot)).toThrow(/Repo pnpm store is missing @swc\+helpers@0\.5\.23/);
  });

  it("throws when the standalone pnpm store is missing", () => {
    const root = makeTempDir();
    const standaloneRoot = join(root, "standalone");
    const repoPnpmRoot = join(root, "repo-pnpm");
    mkdirSync(standaloneRoot, { recursive: true });
    mkdirSync(repoPnpmRoot, { recursive: true });

    expect(() => completeStandaloneSwcHelpers(standaloneRoot, repoPnpmRoot)).toThrow(/Standalone pnpm store not found/);
  });
});
