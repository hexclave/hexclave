import { parseTar } from "@hexclave/shared/dist/utils/tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { packageSourceDirectory } from "./source-packaging.js";

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexclave-package-test-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const write = (root: string, relativePath: string, content: string) => {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
};

const packagedPaths = (root: string) => {
  const packaged = packageSourceDirectory(root);
  const entries = parseTar(gunzipSync(packaged.tarballGzipped), { maxEntries: 10_000, maxTotalBytes: 100 * 1024 * 1024 });
  return entries.map((entry) => entry.path);
};

describe("packageSourceDirectory", () => {
  it("packages files with deterministic ordering and roundtrips content", () => {
    const root = makeTempDir();
    write(root, "package.json", `{"name":"x"}`);
    write(root, "src/index.ts", "export {}\n");
    write(root, "src/a.ts", "// a\n");

    const packaged = packageSourceDirectory(root);
    const entries = parseTar(gunzipSync(packaged.tarballGzipped), { maxEntries: 100, maxTotalBytes: 1024 * 1024 });
    expect(entries.map((entry) => entry.path)).toEqual(["package.json", "src/a.ts", "src/index.ts"]);
    expect(new TextDecoder().decode(entries[0].data)).toBe(`{"name":"x"}`);
    expect(packaged.fileCount).toBe(3);

    // Byte-identical when repackaged (fixed mtimes, sorted entries).
    expect(Buffer.compare(packageSourceDirectory(root).tarballGzipped, packaged.tarballGzipped)).toBe(0);
  });

  it("always drops node_modules and .git, even without ignore files", () => {
    const root = makeTempDir();
    write(root, "index.js", "");
    write(root, "node_modules/pkg/index.js", "");
    write(root, ".git/HEAD", "");
    write(root, "nested/node_modules/pkg/index.js", "");
    expect(packagedPaths(root)).toEqual(["index.js"]);
  });

  it("respects .gitignore and .dockerignore including negation", () => {
    const root = makeTempDir();
    write(root, ".gitignore", "*.log\ndist/\n!keep.log\n");
    write(root, ".dockerignore", "*.md\n");
    write(root, "app.js", "");
    write(root, "error.log", "");
    write(root, "keep.log", "");
    write(root, "README.md", "");
    write(root, "dist/out.js", "");
    expect(packagedPaths(root)).toEqual([".dockerignore", ".gitignore", "app.js", "keep.log"]);
  });

  it("applies nested .gitignore files relative to their directory", () => {
    const root = makeTempDir();
    write(root, "sub/.gitignore", "local-only.txt\n");
    write(root, "sub/local-only.txt", "");
    write(root, "sub/kept.txt", "");
    write(root, "local-only.txt", "");
    expect(packagedPaths(root)).toEqual(["local-only.txt", "sub/.gitignore", "sub/kept.txt"]);
  });

  it("inherits ignore files above a monorepo service root", () => {
    const root = makeTempDir();
    write(root, ".gitignore", "*.log\npackages/api/generated/\n");
    write(root, ".dockerignore", "packages/api/private.txt\n");
    write(root, "packages/api/index.ts", "");
    write(root, "packages/api/error.log", "");
    write(root, "packages/api/generated/client.ts", "");
    write(root, "packages/api/private.txt", "");

    const packaged = packageSourceDirectory(path.join(root, "packages/api"), root);
    const entries = parseTar(gunzipSync(packaged.tarballGzipped), { maxEntries: 100, maxTotalBytes: 1024 * 1024 });
    expect(entries.map((entry) => entry.path)).toEqual(["index.ts"]);
  });

  it("allows a nested ignore file to override an inherited file rule", () => {
    const root = makeTempDir();
    write(root, ".gitignore", "*.log\n");
    write(root, "packages/api/.gitignore", "!keep.log\n");
    write(root, "packages/api/drop.log", "");
    write(root, "packages/api/keep.log", "");

    const packaged = packageSourceDirectory(path.join(root, "packages/api"), root);
    const entries = parseTar(gunzipSync(packaged.tarballGzipped), { maxEntries: 100, maxTotalBytes: 1024 * 1024 });
    expect(entries.map((entry) => entry.path)).toEqual([".gitignore", "keep.log"]);
  });

  it("rejects a source directory outside the ignore/config root", () => {
    const configRoot = makeTempDir();
    const sourceRoot = makeTempDir();
    write(sourceRoot, "index.ts", "");
    expect(() => packageSourceDirectory(sourceRoot, configRoot)).toThrow("must be inside the config directory");
  });

  it("still applies ancestor ignore rules when the source root is reached through an in-tree symlink", () => {
    // `apps/web` is a symlink to `real/web` in the same config directory. Containment holds
    // either way, so packaging proceeds — but the ancestor scopes and the tree walk have to
    // agree on WHICH path space they describe, or the config root's .gitignore stops
    // matching anything and the files it excludes get uploaded.
    // The rule is ANCHORED on purpose: a bare `secret.txt` matches at any depth and would
    // pass under either path space, hiding the divergence this test exists to catch.
    const configRoot = fs.realpathSync(makeTempDir());
    write(configRoot, ".gitignore", "/real/web/secret.txt\n");
    write(configRoot, "real/web/index.ts", "export {}\n");
    write(configRoot, "real/web/secret.txt", "shh");
    fs.mkdirSync(path.join(configRoot, "apps"), { recursive: true });
    fs.symlinkSync(path.join(configRoot, "real", "web"), path.join(configRoot, "apps", "web"));

    const packaged = packageSourceDirectory(path.join(configRoot, "apps", "web"), configRoot);
    expect(packaged.paths).toEqual(["index.ts"]);
  });

  it("skips symlinks", () => {
    const root = makeTempDir();
    write(root, "real.txt", "hi");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    expect(packagedPaths(root)).toEqual(["real.txt"]);
  });

  it("errors on a missing directory", () => {
    expect(() => packageSourceDirectory(path.join(makeTempDir(), "nope"))).toThrow("Source directory not found");
  });

  it("errors when everything is ignored", () => {
    const root = makeTempDir();
    write(root, "node_modules/pkg/index.js", "");
    expect(() => packageSourceDirectory(root)).toThrow("No files to deploy");
  });

  it("reports each packaged file's size, which is what the deploy's manifest is built from", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "small.txt"), "hi");
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), Buffer.alloc(9999));

    const packaged = packageSourceDirectory(dir);
    const sizes = new Map(packaged.files.map((file) => [file.path, file.bytes]));
    expect(sizes.get("small.txt")).toBe(2);
    expect(sizes.get("big.bin")).toBe(4096);
    // Sizes describe what was PACKAGED, so an ignored file contributes nothing —
    // which is exactly what makes the manifest able to prove an ignore rule
    // worked.
    expect(sizes.has("ignored.txt")).toBe(false);
    expect(packaged.files).toHaveLength(packaged.paths.length);
    expect(packaged.totalBytes).toBe(packaged.files.reduce((total, file) => total + file.bytes, 0));
  });

});
