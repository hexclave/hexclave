// Post-build source map preparation for `hexclave sourcemaps upload`.
//
// Mirrors sentry-javascript's `debug-id-upload.ts` where its decisions are
// right, and deliberately departs from it in three places (each explained at
// the relevant function):
//
//  1. We APPEND the debug-id snippet instead of prepending it. Sentry can
//     prepend because it injects pre-minification and lets the bundler
//     regenerate the map; we run AFTER the bundler, so prepending would shift
//     every generated line and silently invalidate every mapping in the
//     already-emitted `.map`. Appending adds lines strictly after all mapped
//     code, which is provably a no-op for the map — and it also avoids
//     breaking ESM `import` hoisting and directive prologues ("use client").
//  2. Debug ids are DERIVED from the bytes, not random, so an unchanged vendor
//     chunk keeps its id across builds and the server can answer
//     `already_uploaded`.
//  3. `sources[]` normalization happens here rather than server-side, so the
//     backend does zero path munging and CI absolute paths never leave the
//     build machine.
//
// Zero new dependencies: node builtins only.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

const BUNDLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git", "cache"]);

const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical lower-case UUID debug id.
 *
 * Sentry normalizes debug ids before indexing them, while Symbolicator uses
 * the exact id to select a JavaScript module. Keeping the CLI manifest
 * canonical prevents two spellings of one artifact becoming two records.
 */
export function isDebugId(value: string): boolean {
  return DEBUG_ID_RE.test(value);
}

// The marker the injected snippet writes into the bundle, and the thing
// `determineDebugIdFromBundleSource` scrapes back out. Same idea as Sentry's
// `sentry-dbid-<uuid>`; the distinct prefix lets both SDKs coexist in one app.
const DEBUG_ID_IDENTIFIER_PREFIX = "hexclave-dbid-";

const SNIPPET_START_MARKER = "// hexclave:debug-id-injection:start";
const SNIPPET_END_MARKER = "// hexclave:debug-id-injection:end";
const SNIPPET_SEPARATOR_MARKER = "// hexclave:debug-id-injection:separator";

/** The exact next.config line to print when a server chunk has no source map. */
export const NEXT_SERVER_SOURCE_MAPS_CONFIG_HINT = "experimental: { serverSourceMaps: true }";

function assertDebugId(debugId: string): void {
  if (!isDebugId(debugId)) {
    throw new CliError(`Invalid debug id ${JSON.stringify(debugId)} — expected a lowercase hyphenated UUID.`);
  }
}

/**
 * `uuidShape(sha256(sha256(minified) ‖ sha256(map)))`.
 *
 * Derived rather than random so that a vendor chunk whose bytes did not change
 * gets the same id on every build: CI can then skip re-uploading it (the server
 * answers `already_uploaded`) and stored artifacts do not grow once per deploy.
 *
 * Hashing the PAIR — not just the minified file — is required: two byte-
 * identical JS files can legitimately carry different maps (different
 * `sourcesContent`, a different bundler version, a different project layout),
 * and collapsing them onto one id would serve the wrong sources.
 */
export function deriveDebugId(minified: Uint8Array, map: Uint8Array): string {
  const digest = createHash("sha256")
    .update(createHash("sha256").update(minified).digest())
    .update(createHash("sha256").update(map).digest())
    .digest();
  // Shape the first 16 bytes as an RFC 4122 v4 UUID. The 6 bits spent on the
  // version/variant nibbles leave 122 bits of the digest, which is far more
  // than enough for collision resistance across one project's artifacts, and
  // buys a value that passes every UUID validator in the pipeline.
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}


/**
 * Extracts a previously injected debug id from a bundle's source.
 *
 * The scraped marker (rather than the `//# debugId=` pragma) is the source of
 * truth because it is the value the RUNTIME will actually register; a pragma
 * without the snippet would promise symbolication that never happens.
 */
export function determineDebugIdFromBundleSource(source: string): string | null {
  const match = new RegExp(`${DEBUG_ID_IDENTIFIER_PREFIX}([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`).exec(source);
  return match === null ? null : match[1].toLowerCase();
}

function buildDebugIdSnippet(debugId: string): string {
  // Notes on the shape:
  //  - Leading `;` for ASI safety: the preceding line of a minified bundle can
  //    end in an expression that would otherwise swallow our `(`.
  //  - IIFE so the temporaries never leak as globals in a classic script chunk.
  //    It adds one frame to the stack, which is harmless — the frame still
  //    names THIS file, which is the only thing the SDK reads.
  //  - `new g.Error()` (the global's constructor, like Sentry) so a chunk
  //    evaluated in another realm still produces a stack.
  //  - try/catch around everything: a locked-down global or a Proxy that throws
  //    on property set must never take down the customer's bundle.
  //  - The trailing `//# debugId=` pragma follows the (draft) source map debug
  //    id convention and is emitted for tools that read it.
  const snippet = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:typeof global!=="undefined"?global:typeof self!=="undefined"?self:{};var s=new g.Error().stack;if(s){g._hexclaveDebugIds=g._hexclaveDebugIds||{};g._hexclaveDebugIds[s]=${JSON.stringify(debugId)};g._hexclaveDebugIdIdentifier=${JSON.stringify(`${DEBUG_ID_IDENTIFIER_PREFIX}${debugId}`)};}}catch(e){}})();`;
  return `${SNIPPET_START_MARKER}\n${snippet}\n//# debugId=${debugId}\n${SNIPPET_END_MARKER}\n`;
}

const SNIPPET_BLOCK_RE = new RegExp(`(?:${SNIPPET_SEPARATOR_MARKER}\\n)?${SNIPPET_START_MARKER}\\n[\\s\\S]*?\\n${SNIPPET_END_MARKER}\\n?`, "g");

// Matches a `//# sourceMappingURL=` / `//@ sourceMappingURL=` line. Anchored to
// whole lines so a URL appearing inside a string literal cannot match.
const SOURCE_MAPPING_URL_LINE_PATTERN = "^[ \\t]*\\/\\/[#@][ \\t]*sourceMappingURL=([^\\s]*)[ \\t]*$";

function findLastSourceMappingUrlMatch(source: string): { url: string, lineStart: number } | null {
  let last: { url: string, lineStart: number } | null = null;
  // A fresh regex per call: the `g` flag makes `lastIndex` stateful, and this
  // module walks many files in one process. The LAST match wins — the spec says
  // a later `sourceMappingURL` supersedes an earlier one.
  const regex = new RegExp(SOURCE_MAPPING_URL_LINE_PATTERN, "gm");
  let match = regex.exec(source);
  while (match !== null) {
    last = { url: match[1], lineStart: match.index };
    match = regex.exec(source);
  }
  return last;
}

/**
 * Appends the debug-id snippet, immediately BEFORE the trailing
 * `//# sourceMappingURL=` line (or at EOF when there is none) so that comment
 * stays last — browsers and Node look for it at the tail of the file.
 *
 * Appending (never prepending) is the whole point: the `.map` next to this file
 * was generated for the current line numbering, and `mappings` is a per-
 * generated-line structure. Inserting anything above mapped code would shift
 * every line and make every frame resolve to the wrong original position.
 * Everything we add sits strictly after the last mapped line, so the existing
 * map stays byte-for-byte correct.
 *
 * Idempotent: calling it again with the same id returns the input unchanged;
 * calling it with a different id removes the previously injected block first,
 * so a file never accumulates snippets.
 */
export function appendDebugIdSnippet(source: string, debugId: string): string {
  assertDebugId(debugId);
  const existing = determineDebugIdFromBundleSource(source);
  if (existing === debugId) return source;

  const stripped = existing === null ? source : source.replace(SNIPPET_BLOCK_RE, "");
  const block = buildDebugIdSnippet(debugId);
  const sourceMappingUrl = findLastSourceMappingUrlMatch(stripped);
  if (sourceMappingUrl === null) {
    if (stripped.endsWith("\n") || stripped === "") return `${stripped}${block}`;
    return `${stripped}\n${SNIPPET_SEPARATOR_MARKER}\n${block}`;
  }
  return `${stripped.slice(0, sourceMappingUrl.lineStart)}${block}${stripped.slice(sourceMappingUrl.lineStart)}`;
}

/**
 * The bundle as it was BEFORE any debug-id injection, normalized so that
 * `stripDebugIdSnippet(appendDebugIdSnippet(x, id))` round-trips exactly.
 *
 * The EOF branch records a separator marker only when injection had to add a
 * newline to a bundle that did not already end in one. Removing that marker
 * with the block preserves the exact clean bytes, so bundles differing only by
 * an EOF newline retain distinct ids on fallback-map uploads.
 */
function canonicalCleanSource(source: string): string {
  const stripped = source.replace(SNIPPET_BLOCK_RE, "");
  return stripped;
}

/**
 * Derives the debug id for a (bundle, map) pair from the bundle's ORIGINAL
 * bytes (any previous injection stripped) and the current map text.
 *
 * Deriving from the clean bundle — rather than trusting whatever id a previous
 * run embedded — keeps a rerun on unchanged output a true no-op while still
 * minting a fresh id when the MAP changed under an otherwise-identical bundle
 * (a map-only rebuild or replacement). Trusting the embedded id there would
 * upload the new map under a stale id and leave symbolication on the old map.
 *
 * Hashing the utf-8 re-encoding of the decoded text rather than the raw file
 * bytes: JS sources are utf-8 by definition, so the round trip is lossless and —
 * the property that matters — deterministic, which is all a derived id needs.
 */
export function deriveBundleDebugId(source: string, mapText: string): string {
  return deriveDebugId(Buffer.from(canonicalCleanSource(source), "utf-8"), Buffer.from(mapText, "utf-8"));
}

/**
 * Returns the JSON text of a map inlined into the bundle as a
 * `sourceMappingURL=data:` URI, or null when there is none.
 *
 * Kept separate from `determineSourceMapPathFromBundle` because an inline map
 * has no path: conflating the two would make the caller fall through to the
 * `<file>.map` heuristic and potentially pick up a STALE map from a previous
 * build that the bundler no longer references.
 */
export function readInlineSourceMap(source: string): string | null {
  const match = findLastSourceMappingUrlMatch(source);
  if (match === null || !/^data:/i.test(match.url)) return null;
  const commaIndex = match.url.indexOf(",");
  if (commaIndex < 0) return null;
  const meta = match.url.slice(0, commaIndex);
  const payload = match.url.slice(commaIndex + 1);
  if (/;base64$/i.test(meta)) {
    return Buffer.from(payload, "base64").toString("utf-8");
  }
  try {
    return decodeURIComponent(payload);
  } catch (error) {
    throw new CliError(`Inline source map has invalid percent encoding: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type DetermineSourceMapPathOptions = {
  containingDir?: string,
};

export function isInside(candidate: string, containingDir: string): boolean {
  const relative = path.relative(containingDir, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isExistingFile(candidate: string): boolean {
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

/**
 * Returns the candidate iff it is an existing file whose REAL path (symlinks
 * resolved) is contained in `containingDir`, else null.
 *
 * The lexical `isInside` check is necessary but not sufficient: an in-root
 * symlink can pass it while its target escapes the build directory, and the
 * subsequent `readFileSync`/`statSync` follow the link — so a dependency that
 * emits a crafted `//# sourceMappingURL=` (or drops a `<bundle>.map` symlink)
 * could smuggle arbitrary external JSON, including attacker-chosen
 * `sourcesContent`, into a prepared upload. Comparing resolved real paths
 * closes that hole. `containingDir` is realpath'd too so a symlinked build root
 * (e.g. macOS `os.tmpdir()`) is not falsely rejected.
 */
function resolveContainedFile(candidate: string, containingDir: string): string | null {
  if (!isExistingFile(candidate)) return null;
  let realCandidate: string;
  let realContaining: string;
  try {
    realCandidate = fs.realpathSync(candidate);
    realContaining = fs.realpathSync(containingDir);
  } catch {
    return null;
  }
  return isInside(realCandidate, realContaining) ? candidate : null;
}

/**
 * Resolves the `.map` file for a bundle: first whatever its
 * `//# sourceMappingURL=` points at, then the `<bundle>.map` fallback.
 *
 * Two classes of `sourceMappingURL` are REJECTED rather than followed:
 *  - `http(s)://` (and any other non-`file:` protocol) — there is no local file
 *    behind it, and turning a remote URL into a path is how a build directory
 *    ends up fetching or reading something it shouldn't.
 *  - anything that escapes `containingDir` via `../` or an absolute path — the
 *    build output is attacker-influenced in the sense that a dependency can
 *    emit whatever comment it likes, and we are about to read the file and
 *    upload its contents.
 * `data:` URIs return null; use `readInlineSourceMap` for those.
 */
export function determineSourceMapPathFromBundle(bundlePath: string, source: string, options?: DetermineSourceMapPathOptions): string | null {
  const bundleDir = path.dirname(path.resolve(bundlePath));
  const containingDir = path.resolve(options?.containingDir ?? bundleDir);
  const match = findLastSourceMappingUrlMatch(source);

  if (match !== null && /^data:/i.test(match.url)) return null;

  const searchLocations: string[] = [];
  if (match !== null && match.url !== "") {
    const referenced = resolveSourceMappingUrlToPath(match.url, bundleDir);
    if (referenced !== null && isInside(referenced, containingDir)) {
      searchLocations.push(referenced);
    }
  }
  searchLocations.push(`${path.resolve(bundlePath)}.map`);

  for (const location of searchLocations) {
    const contained = resolveContainedFile(location, containingDir);
    if (contained !== null) return contained;
  }
  return null;
}

const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function resolveSourceMappingUrlToPath(url: string, bundleDir: string): string | null {
  if (/^file:/i.test(url)) {
    try {
      return path.resolve(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  // Windows drive letters (`C:\...`) look like a protocol to the regex above,
  // so check them before rejecting protocols.
  if (/^[a-zA-Z]:[\\/]/.test(url)) return path.resolve(url);
  if (PROTOCOL_RE.test(url)) return null;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
  }
  return path.resolve(bundleDir, decoded);
}

export type PrepareSourceMapOptions = {
  sourceMapDir: string,
  repoRoot: string,
};

function asJsonObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(`${what} is not a JSON object.`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = entry;
  return result;
}

function validateSourceMapObject(map: Record<string, unknown>, what: string): void {
  if (map.version !== 3) {
    throw new CliError(`${what} must use source map version 3.`);
  }
  if (typeof map.mappings !== "string" && !Array.isArray(map.sections)) {
    throw new CliError(`${what} has neither a \`mappings\` string nor a \`sections\` array — it is not a usable source map.`);
  }
  if (map.mappings !== undefined && typeof map.mappings !== "string") {
    throw new CliError(`${what}.mappings must be a string.`);
  }
  if (map.sources !== undefined && (!Array.isArray(map.sources) || map.sources.some((source) => typeof source !== "string"))) {
    throw new CliError(`${what}.sources must be an array of strings.`);
  }
  if (map.sourceRoot !== undefined && typeof map.sourceRoot !== "string") {
    throw new CliError(`${what}.sourceRoot must be a string when present.`);
  }
  if (map.sections !== undefined) {
    if (!Array.isArray(map.sections)) {
      throw new CliError(`${what}.sections must be an array.`);
    }
    for (const [index, section] of map.sections.entries()) {
      const sectionObject = asJsonObject(section, `${what}.sections[${index}]`);
      const offset = asJsonObject(sectionObject.offset, `${what}.sections[${index}].offset`);
      // The offset locates the section within the generated file; Symbolicator
      // rejects or misreads a section whose line/column are missing, negative, or
      // non-integer, so validate them here rather than upload a map it will choke on.
      if (
        typeof offset.line !== "number" || !Number.isInteger(offset.line) || offset.line < 0
        || typeof offset.column !== "number" || !Number.isInteger(offset.column) || offset.column < 0
      ) {
        throw new CliError(`${what}.sections[${index}].offset must contain non-negative integer \`line\` and \`column\` fields.`);
      }
      const nestedMap = asJsonObject(sectionObject.map, `${what}.sections[${index}].map`);
      validateSourceMapObject(nestedMap, `${what}.sections[${index}].map`);
    }
  }
}

function validateExistingDebugId(map: Record<string, unknown>, key: "debug_id" | "debugId", debugId: string): void {
  const existing = map[key];
  if (existing === undefined) return;
  if (typeof existing !== "string" || !DEBUG_ID_RE.test(existing.toLowerCase())) {
    throw new CliError(`Source map ${key} must be a lowercase hyphenated UUID when present.`);
  }
  if (existing.toLowerCase() !== debugId) {
    throw new CliError(`Source map ${key} ${JSON.stringify(existing)} does not match bundle debug id ${debugId}.`);
  }
}

/**
 * Writes the debug id into a source map and normalizes its `sources[]`,
 * returning the JSON text to upload.
 *
 * BOTH `debug_id` and `debugId` are written. The convention churned while it
 * was being standardized and different readers look for different spellings;
 * Sentry writes both for the same reason, and the cost is 40 bytes.
 *
 * `sources[]` normalization happens here rather than on the backend for two
 * reasons: the ingest path then does zero path munging (it can join on exactly
 * what it stored), and — the real reason — a CI runner's absolute paths
 * (`/home/runner/work/<org>/<repo>/src/...`) would otherwise be persisted and
 * rendered verbatim in the dashboard for anyone with issue access.
 */
export function prepareSourceMapForUpload(mapJson: unknown, debugId: string, options: PrepareSourceMapOptions): string {
  assertDebugId(debugId);
  const map = asJsonObject(mapJson, "Source map");
  validateSourceMapObject(map, "Source map");
  validateExistingDebugId(map, "debug_id", debugId);
  validateExistingDebugId(map, "debugId", debugId);
  map.debug_id = debugId;
  map.debugId = debugId;
  normalizeSourcesInPlace(map, options);
  if (Array.isArray(map.sections)) {
    map.sections = map.sections.map((section: unknown) => {
      if (typeof section !== "object" || section === null || Array.isArray(section)) return section;
      const sectionObject = asJsonObject(section, "Source map section");
      if (typeof sectionObject.map === "object" && sectionObject.map !== null && !Array.isArray(sectionObject.map)) {
        const nested = asJsonObject(sectionObject.map, "Source map section map");
        normalizeSourcesInPlace(nested, options);
        sectionObject.map = nested;
      }
      return sectionObject;
    });
  }
  return JSON.stringify(map);
}

function normalizeSourcesInPlace(map: Record<string, unknown>, options: PrepareSourceMapOptions): void {
  const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : null;
  if (Array.isArray(map.sources)) {
    map.sources = map.sources.map((source: unknown) => typeof source === "string" ? normalizeSourcePath(source, sourceRoot, options) : source);
  }
  delete map.sourceRoot;
}

// `webpack://`, `webpack-internal:///`, `turbopack://`, `vite://`, `rollup://`, …
const BUNDLER_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/{2,3}/;
// Synthetic first segments bundlers put where a directory would go. `_N_E` is
// the webpack library name Next.js uses; Turbopack uses bracketed placeholders.
const SYNTHETIC_ROOT_SEGMENT_RE = /^(?:_N_E|\[project\]|\[turbopack\]|\[next\]|\[embedded\])\//;

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

/**
 * Normalizes a path that is going into the upload manifest.
 *
 * Manifest paths are identifiers, not filesystem locations. They must be
 * relative and must not contain traversal segments: accepting an absolute or
 * ambiguous path would let a zip/object-storage adapter disagree with
 * the path the CLI displayed and the path Symbolicator indexes.
 */
export function normalizeArtifactRelativePath(value: string, label = "Artifact path"): string {
  if (value.trim() === "") {
    throw new CliError(`${label} must not be empty.`);
  }
  const posix = toPosix(value);
  if (posix.startsWith("/") || /^[a-zA-Z]:\//.test(posix)) {
    throw new CliError(`${label} must be relative to the scanned build directory (got ${JSON.stringify(value)}).`);
  }
  if (posix.split("/").some((segment) => segment === "..")) {
    throw new CliError(`${label} must not contain \`..\` path segments (got ${JSON.stringify(value)}).`);
  }
  const normalized = path.posix.normalize(posix).replace(/^\.\//, "");
  if (normalized === "" || normalized === ".") {
    throw new CliError(`${label} must identify a file (got ${JSON.stringify(value)}).`);
  }
  return normalized;
}

function isAbsoluteLike(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

export function normalizeSourcePath(source: string, sourceRoot: string | null, options: PrepareSourceMapOptions): string {
  let value = source;
  if (sourceRoot !== null && sourceRoot !== "" && !BUNDLER_PROTOCOL_RE.test(value) && !isAbsoluteLike(value)) {
    value = sourceRoot.endsWith("/") ? `${sourceRoot}${value}` : `${sourceRoot}/${value}`;
  }
  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Leave it; the protocol strip below still produces something readable.
    }
  }

  if (BUNDLER_PROTOCOL_RE.test(value)) {
    // Bundler-protocol sources are stated relative to the PROJECT root, not to
    // the map file — resolving them against the map directory (which for Next
    // is `.next/static/chunks`) would invent a path that never existed.
    value = value.replace(BUNDLER_PROTOCOL_RE, "").replace(SYNTHETIC_ROOT_SEGMENT_RE, "");
  } else if (isAbsoluteLike(value)) {
    value = relativizeAbsolutePath(value, options.repoRoot);
  } else {
    value = relativizeAbsolutePath(path.resolve(options.sourceMapDir, value), options.repoRoot);
  }

  value = path.posix.normalize(toPosix(value));
  return value.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
}

function relativizeAbsolutePath(absolutePath: string, repoRoot: string): string {
  const relative = path.relative(path.resolve(repoRoot), absolutePath);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return toPosix(relative);
  }
  const posix = toPosix(absolutePath);
  const nodeModulesIndex = posix.lastIndexOf("node_modules/");
  if (nodeModulesIndex >= 0) return posix.slice(nodeModulesIndex);
  return path.posix.basename(posix);
}


export type SourceMapArtifactCandidate = {
  bundlePath: string,
  scanDir: string,
  sourceMapPath: string | null,
  hasInlineSourceMap: boolean,
  /** True for chunks emitted into a Next.js server build (`.next/server/**`). */
  isServerBundle: boolean,
};

/** Whether a path lives in a Next.js server build output. */
export function isNextServerBundlePath(absolutePath: string): boolean {
  const posix = toPosix(absolutePath);
  return posix.includes("/.next/server/") || posix.includes("/.next/standalone/");
}

function listFilesRecursively(dir: string): string[] {
  // `recursive: true` on readdirSync is Node >= 18.17 and returns paths
  // relative to `dir`, including directories. That is enough here and keeps the
  // CLI free of a glob dependency.
  const entries = fs.readdirSync(dir, { recursive: true, encoding: "utf-8" });
  const files: string[] = [];
  for (const relative of entries) {
    const segments = toPosix(relative).split("/");
    if (segments.some((segment) => SKIPPED_DIRECTORY_NAMES.has(segment))) continue;
    const absolute = path.join(dir, relative);
    if (isExistingFile(absolute)) files.push(absolute);
  }
  return files;
}

/**
 * Finds every bundle file under `dirs` and resolves its source map.
 *
 * Overlapping scan directories (e.g. `.next` and `.next/static`) are handled by
 * de-duplicating on the bundle path — the first directory that saw a file wins,
 * so each artifact is prepared and uploaded exactly once.
 */
export function collectArtifacts(dirs: readonly string[]): SourceMapArtifactCandidate[] {
  const byBundlePath = new Map<string, SourceMapArtifactCandidate>();
  for (const dir of dirs) {
    const scanDir = path.resolve(dir);
    const stat = fs.statSync(scanDir, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      throw new CliError(`Not a directory: ${scanDir}`);
    }
    for (const bundlePath of listFilesRecursively(scanDir)) {
      if (!BUNDLE_EXTENSIONS.has(path.extname(bundlePath))) continue;
      if (byBundlePath.has(bundlePath)) continue;
      const source = fs.readFileSync(bundlePath, "utf-8");
      byBundlePath.set(bundlePath, {
        bundlePath,
        scanDir,
        sourceMapPath: determineSourceMapPathFromBundle(bundlePath, source, { containingDir: scanDir }),
        hasInlineSourceMap: readInlineSourceMap(source) !== null,
        isServerBundle: isNextServerBundlePath(bundlePath),
      });
    }
  }
  return [...byBundlePath.values()].sort((a, b) => a.bundlePath < b.bundlePath ? -1 : a.bundlePath > b.bundlePath ? 1 : 0);
}


const MANIFEST_FILE_RE = /manifest.*\.(?:json|js)$/i;
const INTEGRITY_FIELD_RE = /["']?integrity["']?\s*:\s*["']/;

/**
 * Finds build manifests that carry subresource-integrity hashes.
 *
 * These are computed by the bundler over the bundle bytes as they were emitted.
 * Appending our snippet changes those bytes, so every injected chunk would be
 * rejected by the browser at load time — the app would break in production with
 * an opaque SRI error. There is no safe silent behaviour here, so the caller
 * must fail loudly.
 */
export function findIntegrityManifests(dirs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dir of dirs) {
    const scanDir = path.resolve(dir);
    const stat = fs.statSync(scanDir, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) continue;
    for (const filePath of listFilesRecursively(scanDir)) {
      if (!MANIFEST_FILE_RE.test(path.basename(filePath))) continue;
      if (INTEGRITY_FIELD_RE.test(fs.readFileSync(filePath, "utf-8"))) found.add(filePath);
    }
  }
  return [...found].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function findNextBuildRoots(dirs: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const dir of dirs) {
    let current = path.resolve(dir);
    for (;;) {
      if (path.basename(current) === ".next") {
        roots.add(current);
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...roots].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
