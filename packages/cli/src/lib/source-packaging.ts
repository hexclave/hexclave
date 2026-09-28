// Packages a source directory into a gzipped ustar tarball for
// `hexclave deploy`. Respects .gitignore and .dockerignore files (at every
// directory level, like git), and always drops node_modules, .git, and
// symlinks. The output is deterministic for identical input trees (sorted
// entries, fixed mtime in the tar writer), which makes retried deploys upload
// byte-identical tarballs.
//
// KNOWN DIVERGENCE — .dockerignore is parsed with GIT semantics here, which differs from
// `docker build` in two ways: (1) an unanchored pattern (`dist`) matches at ANY depth, but
// docker matches `.dockerignore` patterns against the whole path relative to the context
// root (`dist` = top-level only; `**/dist` for any depth); (2) docker reads exactly one
// `.dockerignore` at the context root, whereas this reads one at every directory level. In a
// monorepo, a nested `.dockerignore` written for building that subdir as its own context can
// therefore over-exclude here. Common flat ignore files behave identically; the full
// docker-semantics parser is a tracked follow-up. Note also: unlike `docker build`, a
// `.dockerignore` that lists the Dockerfile DOES drop it (docker special-cases and sends it
// anyway) — for services with a `dockerfilePath`, the deploy pre-flight verifies the
// Dockerfile survived packaging and errors early.

import { createTar, type TarEntry } from "@hexclave/shared/dist/utils/tar";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CliError } from "./errors.js";
import { type IgnoreRule, parseIgnoreFile } from "./ignore-rules.js";

const IGNORE_FILE_NAMES = [".gitignore", ".dockerignore"];
const ALWAYS_EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git"]);

type IgnoreScope = {
  // Absolute path of the directory containing the ignore file. Keeping this
  // absolute lets a service rooted in a monorepo subdirectory still inherit
  // ignore files from the config/repository root.
  baseDirectory: string,
  rules: IgnoreRule[],
};

function relativeToScope(scope: IgnoreScope, absolutePath: string): string | undefined {
  const relativePath = path.relative(scope.baseDirectory, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(path.sep).join("/");
}

function isIgnored(scopes: IgnoreScope[], absolutePath: string, isDirectory: boolean): boolean {
  // Deeper ignore files take precedence, mirroring git: evaluate scopes
  // outermost-first and let later (deeper) matches override earlier ones.
  let ignored = false;
  for (const scope of scopes) {
    const scopedPath = relativeToScope(scope, absolutePath);
    if (scopedPath === undefined) continue;
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(scopedPath)) {
        ignored = !rule.negated;
      }
    }
  }
  return ignored;
}

export type PackagedSource = {
  tarballGzipped: Buffer,
  fileCount: number,
  totalBytes: number,
  // The packaged file paths (posix, relative to the root), so callers can assert on the
  // ACTUAL contents (e.g. Dockerfile presence) after the ignore rules.
  paths: string[],
  // The same entries with their uncompressed sizes, which is what the deploy
  // reports as the source manifest. Sizes are already in hand here (the packager
  // holds every file it wrote); recomputing them later would mean re-reading the
  // tree after the ignore rules had been applied.
  files: { path: string, bytes: number }[],
};

function readIgnoreScopes(directory: string): IgnoreScope[] {
  const scopes: IgnoreScope[] = [];
  for (const ignoreFileName of IGNORE_FILE_NAMES) {
    const ignoreFilePath = path.join(directory, ignoreFileName);
    if (fs.existsSync(ignoreFilePath) && fs.statSync(ignoreFilePath).isFile()) {
      scopes.push({ baseDirectory: directory, rules: parseIgnoreFile(fs.readFileSync(ignoreFilePath, "utf-8")) });
    }
  }
  return scopes;
}

/**
 * Packages `rootDirectory`. `ignoreRootDirectory` is the outermost directory
 * whose ignore files apply; deploy passes the config directory so a service in
 * a monorepo subdirectory inherits the repository-level .gitignore and
 * .dockerignore rules.
 */
export function packageSourceDirectory(rootDirectory: string, ignoreRootDirectory: string = rootDirectory): PackagedSource {
  const absoluteRootDirectory = path.resolve(rootDirectory);
  const absoluteIgnoreRootDirectory = path.resolve(ignoreRootDirectory);
  const rootStat = fs.statSync(absoluteRootDirectory, { throwIfNoEntry: false });
  if (rootStat == null || !rootStat.isDirectory()) {
    throw new CliError(`Source directory not found: ${absoluteRootDirectory}`);
  }
  // Containment is checked on REAL paths. path.resolve/path.relative only prove
  // LEXICAL containment, while statSync and readdirSync follow symlinks — so a
  // rootDirectory (or any ancestor of it) that is an in-tree symlink pointing
  // outside the config directory would pass a lexical check and then be walked,
  // uploading unrelated files. The per-entry symlink skip below never sees this
  // because it only inspects children, not the root it starts from.
  const realRootDirectory = fs.realpathSync(absoluteRootDirectory);
  const realIgnoreRootDirectory = fs.realpathSync(absoluteIgnoreRootDirectory);
  const relativeRootFromIgnoreRoot = path.relative(realIgnoreRootDirectory, realRootDirectory);
  if (relativeRootFromIgnoreRoot === ".." || relativeRootFromIgnoreRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRootFromIgnoreRoot)) {
    throw new CliError(`Source directory ${absoluteRootDirectory} must be inside the config directory ${absoluteIgnoreRootDirectory}.${realRootDirectory === absoluteRootDirectory ? "" : ` It resolves to ${realRootDirectory}, which is outside it — check for a symlink.`}`);
  }

  const entries: TarEntry[] = [];
  let totalBytes = 0;

  const walk = (absoluteDir: string, relativeDir: string, parentScopes: IgnoreScope[]) => {
    const scopes = [...parentScopes, ...readIgnoreScopes(absoluteDir)];

    const dirents = fs.readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const dirent of dirents) {
      const relativePath = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
      const absolutePath = path.join(absoluteDir, dirent.name);
      if (dirent.isSymbolicLink()) {
        // Symlinks are dropped: our tar subset doesn't represent them, and
        // following them risks packaging files outside the source directory.
        continue;
      }
      if (dirent.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIR_NAMES.has(dirent.name)) continue;
        if (isIgnored(scopes, absolutePath, true)) continue;
        walk(absolutePath, relativePath, scopes);
      } else if (dirent.isFile()) {
        if (isIgnored(scopes, absolutePath, false)) continue;
        const data = fs.readFileSync(absolutePath);
        totalBytes += data.length;
        entries.push({ path: relativePath, data });
      }
      // Sockets, FIFOs, devices: silently skipped.
    }
  };

  // ONE PATH SPACE, the real one, for all three of: the relative chain computed above, the
  // ancestor walk that collects their ignore files, and the walk of the source tree itself.
  //
  // `relativeRootFromIgnoreRoot` is derived from the REAL paths, so descending it from the
  // lexical ignore root produces `IgnoreScope.baseDirectory` values that belong to neither
  // chain whenever an in-tree symlink makes the two diverge. `isIgnored` then compares the
  // absolute paths `walk` hands it against those bases, `relativeToScope` misses on every
  // one, and every inherited .gitignore/.dockerignore rule silently stops applying — the
  // failure mode being that files those rules exclude get packaged and uploaded.
  const ancestorScopes: IgnoreScope[] = [];
  const relativeSegments = relativeRootFromIgnoreRoot === "" ? [] : relativeRootFromIgnoreRoot.split(path.sep);
  let currentDirectory = realIgnoreRootDirectory;
  for (const segment of relativeSegments) {
    ancestorScopes.push(...readIgnoreScopes(currentDirectory));
    const childDirectory = path.join(currentDirectory, segment);
    // Git cannot re-include a directory once a parent ignore file prunes it.
    if (isIgnored(ancestorScopes, childDirectory, true)) {
      throw new CliError(`No files to deploy in ${absoluteRootDirectory} (the source directory is ignored by a parent .gitignore or .dockerignore).`);
    }
    currentDirectory = childDirectory;
  }
  walk(realRootDirectory, "", ancestorScopes);

  if (entries.length === 0) {
    throw new CliError(`No files to deploy in ${absoluteRootDirectory} (everything is ignored or the directory is empty).`);
  }

  let tarball;
  try {
    tarball = createTar(entries);
  } catch (error) {
    if (error instanceof StatusError) {
      // The shared tar writer throws StatusError (it also runs on the
      // backend); in the CLI that class isn't handled by main()'s
      // CliError/AuthError catch and would crash with a Sentry report, so
      // rewrap it as a normal user-facing CLI error.
      throw new CliError(error.message);
    }
    throw error;
  }
  return {
    tarballGzipped: gzipSync(tarball),
    fileCount: entries.length,
    totalBytes,
    paths: entries.map((entry) => entry.path),
    files: entries.map((entry) => ({ path: entry.path, bytes: entry.data.length })),
  };
}
