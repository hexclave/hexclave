import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSourceMapManifest,
  createSourceMapUploadPlan,
  prepareArtifacts,
  registerSourceMapsCommand,
  SourceMapUploadHttpError,
  SourceMapUploadProtocolError,
  uploadPreparedSourceMaps,
  type SourceMapUploadRequest,
} from "../commands/source-maps.js";
import { CliError } from "./errors.js";
import {
  appendDebugIdSnippet,
  collectArtifacts,
  deriveDebugId,
  determineDebugIdFromBundleSource,
  determineSourceMapPathFromBundle,
  findIntegrityManifests,
  findNextBuildRoots,
  normalizeSourcePath,
  prepareSourceMapForUpload,
  readInlineSourceMap,
} from "./source-maps.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE_BUNDLE = fs.readFileSync(path.join(FIXTURES_DIR, "minified-chunk.js"), "utf-8");
const FIXTURE_MAP_TEXT = fs.readFileSync(path.join(FIXTURES_DIR, "minified-chunk.js.map"), "utf-8");

const DEBUG_ID_A = "11111111-2222-4333-8444-555555555555";
const DEBUG_ID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// A minimal source-map reader.
//
// `@jridgewell/trace-mapping` does not resolve from this package and the CLI
// takes zero new dependencies, so the mapping-invariance test — the single most
// important test in this file — decodes the VLQ `mappings` itself. It is a
// direct transcription of the source map spec's decoding rules.

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlqValues(text: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let accumulator = 0;
  for (const character of text) {
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error(`Invalid base64 VLQ character: ${character}`);
    accumulator += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const isNegative = (accumulator & 1) === 1;
    accumulator >>>= 1;
    values.push(isNegative ? -accumulator : accumulator);
    accumulator = 0;
    shift = 0;
  }
  return values;
}

type MappingSegment = { generatedColumn: number, sourceIndex: number, originalLine: number, originalColumn: number };

function decodeMappings(mappings: string): MappingSegment[][] {
  const lines: MappingSegment[][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const lineText of mappings.split(";")) {
    let generatedColumn = 0;
    const segments: MappingSegment[] = [];
    for (const segmentText of lineText.split(",")) {
      if (segmentText === "") continue;
      const values = decodeVlqValues(segmentText);
      generatedColumn += values[0];
      if (values.length < 4) continue;
      sourceIndex += values[1];
      originalLine += values[2];
      originalColumn += values[3];
      segments.push({ generatedColumn, sourceIndex, originalLine, originalColumn });
    }
    lines.push(segments);
  }
  return lines;
}

type ResolvedPosition = { source: string, line: number, column: number };

/** `line` is 1-based and `column` 0-based, exactly like the source map spec. */
function originalPositionFor(mapText: string, line: number, column: number): ResolvedPosition | null {
  const map: unknown = JSON.parse(mapText);
  if (typeof map !== "object" || map === null) throw new Error("not a map");
  const mappings = Reflect.get(map, "mappings");
  const sources = Reflect.get(map, "sources");
  if (typeof mappings !== "string" || !Array.isArray(sources)) throw new Error("not a map");
  const segments = decodeMappings(mappings)[line - 1] ?? [];
  let best: MappingSegment | null = null;
  for (const segment of segments) {
    if (segment.generatedColumn > column) break;
    best = segment;
  }
  if (best === null) return null;
  return { source: String(sources[best.sourceIndex]), line: best.originalLine + 1, column: best.originalColumn };
}

function positionOf(source: string, needle: string): { line: number, column: number } {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const before = source.slice(0, index);
  return { line: before.split("\n").length, column: index - (before.lastIndexOf("\n") + 1) };
}


const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hexclave-sourcemaps-")));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir: string, relativePath: string, contents: string): string {
  const absolute = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents, "utf-8");
  return absolute;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("appendDebugIdSnippet — mapping invariance", () => {
  it("does not shift any mapping: a known position resolves identically before and after injection", () => {
    const needle = "greet() requires a name";
    const beforePosition = positionOf(FIXTURE_BUNDLE, needle);
    const beforeResolved = originalPositionFor(FIXTURE_MAP_TEXT, beforePosition.line, beforePosition.column);
    expect(beforeResolved).toEqual({ source: "../src/greeter.ts", line: 3, column: 20 });

    const injected = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);
    expect(injected).not.toBe(FIXTURE_BUNDLE);

    const afterPosition = positionOf(injected, needle);
    expect(afterPosition).toEqual(beforePosition);
    expect(originalPositionFor(FIXTURE_MAP_TEXT, afterPosition.line, afterPosition.column)).toEqual(beforeResolved);
  });

  it("leaves the .map's `mappings` string untouched and puts everything after the last mapped line", () => {
    const map: unknown = JSON.parse(FIXTURE_MAP_TEXT);
    const mappings = Reflect.get(map as object, "mappings");
    const lastMappedLine = decodeMappings(String(mappings)).length;

    const injected = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);
    const prepared: unknown = JSON.parse(prepareSourceMapForUpload(map, DEBUG_ID_A, { sourceMapDir: FIXTURES_DIR, repoRoot: FIXTURES_DIR }));
    expect(Reflect.get(prepared as object, "mappings")).toBe(mappings);

    const snippetLine = positionOf(injected, "hexclave:debug-id-injection:start").line;
    expect(snippetLine).toBeGreaterThan(lastMappedLine);
  });

  it("keeps the sourceMappingURL comment last", () => {
    const injected = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);
    const lines = injected.split("\n").filter((line) => line !== "");
    expect(lines[lines.length - 1]).toBe("//# sourceMappingURL=minified-chunk.js.map");
  });

  it("appends at EOF when there is no sourceMappingURL comment", () => {
    const source = "console.log(1)";
    const injected = appendDebugIdSnippet(source, DEBUG_ID_A);
    expect(injected.startsWith("console.log(1)\n")).toBe(true);
    expect(determineDebugIdFromBundleSource(injected)).toBe(DEBUG_ID_A);
  });
});

describe("appendDebugIdSnippet — idempotence", () => {
  it("is a no-op the second time with the same id", () => {
    const once = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);
    expect(appendDebugIdSnippet(once, DEBUG_ID_A)).toBe(once);
  });

  it("replaces (never stacks) a previously injected block when the id changes", () => {
    const once = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);
    const twice = appendDebugIdSnippet(once, DEBUG_ID_B);
    expect(determineDebugIdFromBundleSource(twice)).toBe(DEBUG_ID_B);
    expect(twice.includes(DEBUG_ID_A)).toBe(false);
    expect(twice.split("hexclave:debug-id-injection:start").length - 1).toBe(1);
    expect(appendDebugIdSnippet(twice, DEBUG_ID_A)).toBe(once);
  });

  it("rejects a malformed debug id rather than writing it into the bundle", () => {
    expect(() => appendDebugIdSnippet(FIXTURE_BUNDLE, "not-a-uuid")).toThrow(CliError);
  });
});

describe("determineDebugIdFromBundleSource", () => {
  it("returns null for an uninjected bundle and the id for an injected one", () => {
    expect(determineDebugIdFromBundleSource(FIXTURE_BUNDLE)).toBeNull();
    expect(determineDebugIdFromBundleSource(appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A))).toBe(DEBUG_ID_A);
  });
});

describe("injected snippet — runtime round trip", () => {
  it("registers the file's own URL as the innermost frame of the stack it records", () => {
    const filename = "https://app.example.com/_next/static/chunks/main-abc123.js";
    const injected = appendDebugIdSnippet(FIXTURE_BUNDLE, DEBUG_ID_A);

    const context: Record<string, unknown> = {};
    vm.createContext(context);
    vm.runInContext(injected, context, { filename });

    const registry = context._hexclaveDebugIds;
    expect(typeof registry).toBe("object");
    expect(context._hexclaveDebugIdIdentifier).toBe(`hexclave-dbid-${DEBUG_ID_A}`);

    const keys = Object.keys(registry as object);
    expect(keys.length).toBe(1);
    expect(Reflect.get(registry as object, keys[0])).toBe(DEBUG_ID_A);

    // The SDK reads this key with `extractInnermostFrameFilename`
    // (packages/template/.../debug-ids.ts, covered by its own vm round trip).
    // It cannot be imported here — the CLI tsconfig's rootDir is `src`, so a
    // cross-package relative import would break `tsc --noEmit` — so the exact
    // property that function depends on is asserted directly instead.
    const innermostFrame = keys[0].split("\n")[1];
    expect(innermostFrame).toMatch(new RegExp(`^\\s+at (?:.*\\()?${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+:\\d+\\)?$`));
  });

  it("survives a hostile global without throwing into the bundle", () => {
    const injected = appendDebugIdSnippet("var ok = 1;", DEBUG_ID_A);
    const context: Record<string, unknown> = {};
    vm.createContext(context);
    vm.runInContext("Object.defineProperty(globalThis, '_hexclaveDebugIds', { get() { throw new Error('locked down'); } });", context);
    expect(() => vm.runInContext(injected, context, { filename: "/tmp/x.js" })).not.toThrow();
  });
});

describe("determineSourceMapPathFromBundle", () => {
  it("follows the sourceMappingURL comment", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "chunks/a.js", "console.log(1)\n//# sourceMappingURL=../maps/a.js.map\n");
    writeFile(dir, "maps/a.js.map", "{}");
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: dir }))
      .toBe(path.join(dir, "maps/a.js.map"));
  });

  it("falls back to <file>.map when there is no comment", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "a.js", "console.log(1)\n");
    writeFile(dir, "a.js.map", "{}");
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"))).toBe(`${bundlePath}.map`);
  });

  it("returns null for an inline data: map instead of picking up a stale <file>.map", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "a.js", "console.log(1)\n//# sourceMappingURL=data:application/json;base64,e30=\n");
    writeFile(dir, "a.js.map", "{\"stale\":true}");
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"))).toBeNull();
  });

  it("rejects http(s) sourceMappingURLs", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "a.js", "console.log(1)\n//# sourceMappingURL=https://cdn.example.com/a.js.map\n");
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"))).toBeNull();
  });

  it("rejects ../ traversal that escapes the scanned directory", () => {
    const dir = makeTempDir();
    const outside = writeFile(dir, "outside/secret.map", "{}");
    const bundlePath = writeFile(dir, "build/chunks/a.js", "console.log(1)\n//# sourceMappingURL=../../outside/secret.map\n");
    expect(fs.existsSync(outside)).toBe(true);
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: path.join(dir, "build") })).toBeNull();
  });

  it("rejects an absolute path outside the scanned directory", () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    const outside = writeFile(outsideDir, "secret.map", "{}");
    const bundlePath = writeFile(dir, "a.js", `console.log(1)\n//# sourceMappingURL=${outside}\n`);
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: dir })).toBeNull();
  });

  it("rejects an in-root symlink whose target escapes the scanned directory", () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    const secret = writeFile(outsideDir, "secret.map", JSON.stringify({ version: 3, sourcesContent: ["secret"] }));
    const bundlePath = writeFile(dir, "build/a.js", "console.log(1)\n//# sourceMappingURL=a.js.map\n");
    fs.symlinkSync(secret, path.join(dir, "build/a.js.map"));
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: path.join(dir, "build") })).toBeNull();
  });

  it("rejects the <bundle>.map fallback when it is a symlink escaping the scan root", () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    const secret = writeFile(outsideDir, "secret.map", JSON.stringify({ version: 3 }));
    const bundlePath = writeFile(dir, "a.js", "console.log(1)\n");
    fs.symlinkSync(secret, `${bundlePath}.map`);
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: dir })).toBeNull();
  });

  it("still follows an in-root symlink whose target stays inside the scan root", () => {
    const dir = makeTempDir();
    const realMap = writeFile(dir, "maps/a.js.map", "{}");
    const bundlePath = writeFile(dir, "chunks/a.js", "console.log(1)\n//# sourceMappingURL=../linked.map\n");
    fs.symlinkSync(realMap, path.join(dir, "linked.map"));
    expect(determineSourceMapPathFromBundle(bundlePath, fs.readFileSync(bundlePath, "utf-8"), { containingDir: dir }))
      .toBe(path.join(dir, "linked.map"));
  });
});

describe("readInlineSourceMap", () => {
  it("decodes base64 and percent-encoded data URIs, and ignores file references", () => {
    const base64 = Buffer.from("{\"version\":3}", "utf-8").toString("base64");
    expect(readInlineSourceMap(`x\n//# sourceMappingURL=data:application/json;base64,${base64}\n`)).toBe("{\"version\":3}");
    expect(readInlineSourceMap("x\n//# sourceMappingURL=data:application/json,%7B%22version%22%3A3%7D\n")).toBe("{\"version\":3}");
    expect(readInlineSourceMap("x\n//# sourceMappingURL=a.js.map\n")).toBeNull();
  });

  it("rejects malformed percent encoding with a typed CLI error", () => {
    expect(() => readInlineSourceMap("x\n//# sourceMappingURL=data:application/json,%ZZ\n")).toThrow(CliError);
  });
});

describe("deriveDebugId", () => {
  const minified = Buffer.from("console.log(1)", "utf-8");
  const map = Buffer.from("{\"version\":3,\"mappings\":\"AAAA\"}", "utf-8");

  it("is deterministic for the same (minified, map) pair", () => {
    expect(deriveDebugId(minified, map)).toBe(deriveDebugId(minified, map));
  });

  it("has a UUID shape", () => {
    expect(deriveDebugId(minified, map)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("changes when only the map changes — byte-identical JS can have different maps", () => {
    const otherMap = Buffer.from("{\"version\":3,\"mappings\":\"AACA\"}", "utf-8");
    expect(deriveDebugId(minified, otherMap)).not.toBe(deriveDebugId(minified, map));
  });

  it("changes when only the minified bytes change", () => {
    expect(deriveDebugId(Buffer.from("console.log(2)", "utf-8"), map)).not.toBe(deriveDebugId(minified, map));
  });
});

describe("prepareSourceMapForUpload", () => {
  const options = { sourceMapDir: "/build/repo/.next/static/chunks", repoRoot: "/build/repo" };

  it("writes both debug_id and debugId", () => {
    const prepared: unknown = JSON.parse(prepareSourceMapForUpload({ version: 3, mappings: "AAAA", sources: [] }, DEBUG_ID_A, options));
    expect(Reflect.get(prepared as object, "debug_id")).toBe(DEBUG_ID_A);
    expect(Reflect.get(prepared as object, "debugId")).toBe(DEBUG_ID_A);
  });

  it("normalizes sources and folds away sourceRoot", () => {
    const prepared: unknown = JSON.parse(prepareSourceMapForUpload({
      version: 3,
      mappings: "AAAA",
      sourceRoot: "/build/repo",
      sources: ["src/app/page.tsx"],
    }, DEBUG_ID_A, options));
    expect(Reflect.get(prepared as object, "sources")).toEqual(["src/app/page.tsx"]);
    expect("sourceRoot" in (prepared as object)).toBe(false);
  });

  it("normalizes the sources of an index map's sections", () => {
    const prepared: unknown = JSON.parse(prepareSourceMapForUpload({
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, mappings: "AAAA", sources: ["webpack://_N_E/./src/a.ts"] } }],
    }, DEBUG_ID_A, options));
    const sections = Reflect.get(prepared as object, "sections");
    expect(Array.isArray(sections)).toBe(true);
    expect(Reflect.get(Reflect.get(sections[0], "map"), "sources")).toEqual(["src/a.ts"]);
  });

  it("rejects something that is not a source map", () => {
    expect(() => prepareSourceMapForUpload({ version: 3 }, DEBUG_ID_A, options)).toThrow(CliError);
    expect(() => prepareSourceMapForUpload("nope", DEBUG_ID_A, options)).toThrow(CliError);
    expect(() => prepareSourceMapForUpload({ version: 2, mappings: "AAAA" }, DEBUG_ID_A, options)).toThrow(/version 3/);
  });

  it("rejects a source-map debug ID that conflicts with the bundle metadata", () => {
    expect(() => prepareSourceMapForUpload({ version: 3, mappings: "AAAA", debug_id: DEBUG_ID_B }, DEBUG_ID_A, options))
      .toThrow(/does not match bundle debug id/);
  });

  it("rejects an index-map section whose offset lacks non-negative integer line/column", () => {
    const withOffset = (offset: unknown) => ({
      version: 3,
      sections: [{ offset, map: { version: 3, mappings: "AAAA", sources: [] } }],
    });
    expect(() => prepareSourceMapForUpload(withOffset({ line: 0 }), DEBUG_ID_A, options)).toThrow(/non-negative integer/);
    expect(() => prepareSourceMapForUpload(withOffset({ line: -1, column: 0 }), DEBUG_ID_A, options)).toThrow(/non-negative integer/);
    expect(() => prepareSourceMapForUpload(withOffset({ line: 1.5, column: 0 }), DEBUG_ID_A, options)).toThrow(/non-negative integer/);
    expect(() => prepareSourceMapForUpload(withOffset("nope"), DEBUG_ID_A, options)).toThrow(CliError);
    expect(() => prepareSourceMapForUpload(withOffset({ line: 0, column: 0 }), DEBUG_ID_A, options)).not.toThrow();
  });
});

describe("normalizeSourcePath", () => {
  const options = { sourceMapDir: "/build/repo/.next/static/chunks", repoRoot: "/build/repo" };

  it("strips bundler protocols and synthetic root segments", () => {
    expect(normalizeSourcePath("webpack://_N_E/./src/app/page.tsx", null, options)).toBe("src/app/page.tsx");
    expect(normalizeSourcePath("webpack-internal:///./src/x.tsx", null, options)).toBe("src/x.tsx");
    expect(normalizeSourcePath("turbopack://[project]/src/y.ts", null, options)).toBe("src/y.ts");
  });

  it("makes build-machine absolute paths repo-relative (this is the privacy fix)", () => {
    expect(normalizeSourcePath("/build/repo/src/lib/a.ts", null, options)).toBe("src/lib/a.ts");
    expect(normalizeSourcePath("file:///build/repo/src/lib/a.ts", null, options)).toBe("src/lib/a.ts");
  });

  it("keeps only the package path for files outside the repo, never the machine layout", () => {
    expect(normalizeSourcePath("/home/runner/.pnpm-store/v3/node_modules/lodash/index.js", null, options)).toBe("node_modules/lodash/index.js");
    expect(normalizeSourcePath("/usr/lib/node/weird.js", null, options)).toBe("weird.js");
  });

  it("collapses ../ segments of map-relative sources", () => {
    expect(normalizeSourcePath("../../../src/app/page.tsx", null, options)).toBe("src/app/page.tsx");
  });
});

describe("collectArtifacts", () => {
  function makeNextBuild(): string {
    const dir = makeTempDir();
    writeFile(dir, ".next/static/chunks/main.js", `${FIXTURE_BUNDLE.split("\n")[0]}\n//# sourceMappingURL=main.js.map\n`);
    writeFile(dir, ".next/static/chunks/main.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, ".next/static/chunks/nomap.js", "console.log(1)\n");
    writeFile(dir, ".next/server/chunks/9.js", "console.log(9)\n");
    writeFile(dir, ".next/static/chunks/styles.css", "body{}");
    writeFile(dir, ".next/static/node_modules/ignored.js", "console.log('ignored')\n");
    return dir;
  }

  it("finds bundles, resolves their maps, and flags server chunks", () => {
    const dir = makeNextBuild();
    const artifacts = collectArtifacts([path.join(dir, ".next")]);
    const byName = new Map(artifacts.map((artifact) => [path.relative(path.join(dir, ".next"), artifact.bundlePath), artifact]));
    expect([...byName.keys()].sort((a, b) => a < b ? -1 : 1)).toEqual([
      path.join("server", "chunks", "9.js"),
      path.join("static", "chunks", "main.js"),
      path.join("static", "chunks", "nomap.js"),
    ]);
    expect(byName.get(path.join("static", "chunks", "main.js"))?.sourceMapPath).toBe(path.join(dir, ".next/static/chunks/main.js.map"));
    expect(byName.get(path.join("static", "chunks", "nomap.js"))?.sourceMapPath).toBeNull();
    expect(byName.get(path.join("server", "chunks", "9.js"))?.isServerBundle).toBe(true);
    expect(byName.get(path.join("static", "chunks", "main.js"))?.isServerBundle).toBe(false);
  });

  it("de-duplicates overlapping scan directories", () => {
    const dir = makeNextBuild();
    const artifacts = collectArtifacts([path.join(dir, ".next"), path.join(dir, ".next/static")]);
    expect(new Set(artifacts.map((artifact) => artifact.bundlePath)).size).toBe(artifacts.length);
  });

  it("throws on a directory that does not exist", () => {
    expect(() => collectArtifacts([path.join(makeTempDir(), "nope")])).toThrow(CliError);
  });
});

describe("findIntegrityManifests / findNextBuildRoots", () => {
  it("detects integrity hashes in a build manifest (appending would break SRI)", () => {
    const dir = makeTempDir();
    writeFile(dir, ".next/build-manifest.json", JSON.stringify({ pages: { "/": ["static/chunks/main.js"] } }));
    expect(findIntegrityManifests([path.join(dir, ".next")])).toEqual([]);
    writeFile(dir, ".next/app-build-manifest.json", JSON.stringify({ pages: { "/": [{ src: "a.js", integrity: "sha384-abc" }] } }));
    expect(findIntegrityManifests([path.join(dir, ".next")])).toEqual([path.join(dir, ".next/app-build-manifest.json")]);
  });

  it("detects integrity in a JavaScript manifest with unquoted or single-quoted keys", () => {
    const dir = makeTempDir();
    writeFile(dir, ".next/unquoted-manifest.js", "self.__M = { chunk: { integrity: \"sha384-abc\" } };");
    writeFile(dir, ".next/single-quoted-manifest.js", "self.__M = { chunk: { 'integrity': 'sha384-def' } };");
    writeFile(dir, ".next/clean-manifest.js", "self.__BUILD_MANIFEST = { \"/\": [\"static/chunks/main.js\"] };");
    expect(findIntegrityManifests([path.join(dir, ".next")])).toEqual([
      path.join(dir, ".next/single-quoted-manifest.js"),
      path.join(dir, ".next/unquoted-manifest.js"),
    ]);
  });

  it("walks up to the enclosing .next directory", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, ".next/static/chunks"), { recursive: true });
    expect(findNextBuildRoots([path.join(dir, ".next/static/chunks")])).toEqual([path.join(dir, ".next")]);
    expect(findNextBuildRoots([dir])).toEqual([]);
  });
});

describe("prepareArtifacts (the whole --dry-run path)", () => {
  it("derives ids, prepares maps, and leaves the build output untouched in dry-run", () => {
    const dir = makeTempDir();
    // The fixture's sourceMappingURL names the fixture file; point it at the
    // map we actually write so discovery goes through the comment.
    writeFile(dir, ".next/static/chunks/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, ".next/static/chunks/main.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, ".next/server/chunks/9.js", "module.exports = 9;\n");

    const candidates = collectArtifacts([path.join(dir, ".next")]);
    const before = fs.readFileSync(path.join(dir, ".next/static/chunks/main.js"), "utf-8");
    const result = prepareArtifacts(candidates, { repoRoot: dir, dryRun: true });

    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0].debugId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.artifacts[0].sourceMapGzipped.length).toBeGreaterThan(0);
    expect(result.artifacts[0].sourceMapSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.serverBundlesWithoutMaps).toEqual([path.join("server", "chunks", "9.js")]);
    expect(fs.readFileSync(path.join(dir, ".next/static/chunks/main.js"), "utf-8")).toBe(before);
  });

  it("tracks mapless client bundles separately from server ones so --strict can catch them", () => {
    const dir = makeTempDir();
    // A client chunk with a map, a client chunk WITHOUT one, and a server chunk
    // without one. The mapless client chunk must be reported (otherwise strict
    // CI passes on an unsymbolicatable client build); the server chunk keeps its
    // Next.js-specific hint path.
    writeFile(dir, ".next/static/chunks/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, ".next/static/chunks/main.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, ".next/static/chunks/nomap.js", "console.log(1)\n");
    writeFile(dir, ".next/server/chunks/9.js", "module.exports = 9;\n");

    const result = prepareArtifacts(collectArtifacts([path.join(dir, ".next")]), { repoRoot: dir, dryRun: true });
    expect(result.clientBundlesWithoutMaps).toEqual([path.join("static", "chunks", "nomap.js")]);
    expect(result.serverBundlesWithoutMaps).toEqual([path.join("server", "chunks", "9.js")]);
  });

  it("writes the snippet once and re-uses the same debug id on a second run", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);

    const first = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false });
    const afterFirst = fs.readFileSync(bundlePath, "utf-8");
    expect(determineDebugIdFromBundleSource(afterFirst)).toBe(first.artifacts[0].debugId);

    const second = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false });
    expect(second.artifacts[0].debugId).toBe(first.artifacts[0].debugId);
    expect(fs.readFileSync(bundlePath, "utf-8")).toBe(afterFirst);
  });

  it("re-derives distinct ids for different bundles a previous run injected with the same id", () => {
    const dir = makeTempDir();
    writeFile(dir, "static/a.js", appendDebugIdSnippet(FIXTURE_BUNDLE.replace("minified-chunk.js.map", "a.js.map"), DEBUG_ID_A));
    writeFile(dir, "static/b.js", appendDebugIdSnippet(FIXTURE_BUNDLE.replace("minified-chunk.js.map", "b.js.map"), DEBUG_ID_A));
    writeFile(dir, "static/a.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, "static/b.js.map", FIXTURE_MAP_TEXT);

    const result = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false });
    const ids = result.artifacts.map((artifact) => artifact.debugId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(DEBUG_ID_A);
  });

  it("re-mints the debug id (and re-injects) when only the source map changed", () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    const mapPath = writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);

    const first = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false });
    const firstId = first.artifacts[0].debugId;
    expect(determineDebugIdFromBundleSource(fs.readFileSync(bundlePath, "utf-8"))).toBe(firstId);

    fs.writeFileSync(mapPath, `${FIXTURE_MAP_TEXT} `, "utf-8");
    const second = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false });
    const secondId = second.artifacts[0].debugId;
    expect(secondId).not.toBe(firstId);
    expect(determineDebugIdFromBundleSource(fs.readFileSync(bundlePath, "utf-8"))).toBe(secondId);
  });

  it("does not partially rewrite earlier bundles when a later map is invalid", () => {
    const dir = makeTempDir();
    const validPath = writeFile(dir, "static/a.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "a.js.map"));
    writeFile(dir, "static/a.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, "static/z.js", "console.log(1)\n//# sourceMappingURL=z.js.map\n");
    writeFile(dir, "static/z.js.map", "not-json");
    const before = fs.readFileSync(validPath, "utf-8");

    expect(() => prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }))
      .toThrow(/not valid JSON/);
    expect(fs.readFileSync(validPath, "utf-8")).toBe(before);
  });

  it("emits deterministic release and debug-ID metadata without absolute paths", () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const result = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: true });
    const manifest = createSourceMapManifest(result.artifacts, "release-2026-08-06", "production", {
      projectId: "project-test",
      dist: "web",
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projectId).toBe("project-test");
    expect(manifest.release).toBe("release-2026-08-06");
    expect(manifest.dist).toBe("web");
    expect(manifest.environment).toBe("production");
    expect(manifest.artifacts[0]?.codeFile).toBe("main.js");
    expect(manifest.artifacts[0]?.sourceMapFile).toBe("main.js.map");
    expect(manifest.artifacts[0]?.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(dir);
  });

  it("creates a stable project-scoped upload plan and rejects a distribution without a release", () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: true }).artifacts;
    const requestInput = {
      auth: {
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://app.example.com",
        publishableClientKey: "pck_test",
        projectId: "project-test",
        secretServerKey: "ssk_test",
      },
      getAuthHeaders: async () => ({}),
      release: "release-2026-08-06",
      dist: "web",
      environment: "production",
      artifacts,
    };
    const first = createSourceMapUploadPlan(requestInput);
    const second = createSourceMapUploadPlan({ ...requestInput, artifacts: [...artifacts].reverse() });
    expect(first.manifestJson).toBe(second.manifestJson);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.projectId).toBe("project-test");
    expect(() => createSourceMapUploadPlan({ ...requestInput, release: null, dist: "web" })).toThrow(/Distribution.*release/);
  });

  it("rejects traversal and duplicate code-file identities before upload", () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifact = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: true }).artifacts
      .find((candidate) => candidate.bundleRelativePath === "main.js");
    if (artifact == null) throw new Error("fixture did not produce an artifact");

    expect(() => createSourceMapManifest([{ ...artifact, bundleRelativePath: "../main.js" }], null, null))
      .toThrow(/relative|\.\./i);
    expect(() => createSourceMapManifest([
      artifact,
      { ...artifact, debugId: DEBUG_ID_B },
    ], null, null)).toThrow(/Duplicate artifact path/);
  });
});

describe("hexclave sourcemaps upload — command wiring", () => {
  async function run(argv: string[]): Promise<{ stdout: string, stderr: string }> {
    const program = new Command();
    program.exitOverride();
    registerSourceMapsCommand(program);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void stdout.push(args.join(" ")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
    try {
      await program.parseAsync(["node", "hexclave", ...argv]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  it("runs end to end under --dry-run without auth or network", async () => {
    const dir = makeTempDir();
    writeFile(dir, ".next/static/chunks/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, ".next/static/chunks/main.js.map", FIXTURE_MAP_TEXT);
    writeFile(dir, ".next/server/chunks/9.js", "module.exports = 9;\n");
    const before = fs.readFileSync(path.join(dir, ".next/static/chunks/main.js"), "utf-8");

    const { stdout, stderr } = await run(["sourcemaps", "upload", path.join(dir, ".next"), "--dry-run", "--release", "v1"]);
    const summary: unknown = JSON.parse(stdout);
    expect(Reflect.get(summary as object, "dryRun")).toBe(true);
    expect(Reflect.get(summary as object, "release")).toBe("v1");
    expect(Array.isArray(Reflect.get(summary as object, "artifacts"))).toBe(true);
    expect(stderr).toContain("experimental: { serverSourceMaps: true }");
    expect(fs.readFileSync(path.join(dir, ".next/static/chunks/main.js"), "utf-8")).toBe(before);
  });

  it("warns and sets a nonzero exit code under --strict when a client bundle has no map", async () => {
    const dir = makeTempDir();
    // A client chunk without any source map. Under --strict this must surface as
    // a warning and a nonzero exit code, not silently pass.
    writeFile(dir, ".next/static/chunks/nomap.js", "console.log(1)\n");
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { stderr } = await run(["sourcemaps", "upload", path.join(dir, ".next"), "--dry-run", "--strict"]);
      expect(stderr).toContain("will not be symbolicated");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("fails loud when the build uses subresource integrity", async () => {
    const dir = makeTempDir();
    writeFile(dir, ".next/static/chunks/main.js", "console.log(1)\n");
    writeFile(dir, ".next/app-build-manifest.json", JSON.stringify({ pages: { "/": [{ src: "a.js", integrity: "sha384-abc" }] } }));
    await expect(run(["sourcemaps", "upload", path.join(dir, ".next"), "--dry-run"])).rejects.toThrow(/subresource integrity/i);
  });

  it("registers, uploads each prepared object, and finalizes with stable idempotency headers", async () => {
    const dir = makeTempDir();
    const bundlePath = writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }).artifacts;
    const artifact = artifacts.at(0);
    if (artifact === undefined) throw new Error("fixture did not produce an artifact");
    const auth = {
      apiUrl: "https://api.example.com",
      dashboardUrl: "https://app.example.com",
      publishableClientKey: "pck_test",
      projectId: "project-test",
      secretServerKey: "ssk_test",
    };
    const requestInput = {
      auth,
      getAuthHeaders: async () => ({
        "x-stack-access-type": "server",
        "x-stack-project-id": "project-test",
        "x-stack-secret-server-key": "ssk_test",
      }),
      release: "release-2026-08-06",
      dist: "web",
      environment: "production",
      artifacts,
    };
    const plan = createSourceMapUploadPlan(requestInput);
    const fetchCalls: Array<{ input: string | URL | Request, init: RequestInit | undefined }> = [];
    const responses: Response[] = [
      new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "registered",
        finalize_path: "/api/latest/source-maps/artifacts/finalize",
        artifacts: [{
          debug_id: artifact.debugId,
          code_file: artifact.bundleRelativePath,
          source_map_file: artifact.sourceMapRelativePath,
          bundle_object_key: "bundles/bundle.js",
          bundle_upload_url: "https://storage.example/bundle",
          source_map_object_key: "maps/map.json.gz",
          source_map_upload_url: "https://storage.example/map",
          already_finalized: false,
        }],
      }), { status: 201 }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 }),
      new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "finalized",
        uploaded: [artifact.debugId],
        already_uploaded: [],
        catalog_status: "published",
      }), { status: 200 }),
    ];
    const fetchMock = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>(async (input, init) => {
      fetchCalls.push({ input, init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected fetch call");
      return response;
    });
    const request: SourceMapUploadRequest = {
      ...requestInput,
      plan,
      transport: { fetch: fetchMock, sleep: async () => undefined },
    };

    const result = await uploadPreparedSourceMaps(request);

    expect(result).toEqual({
      uploaded: [artifact.debugId],
      alreadyUploaded: [],
      catalogStatus: "published",
      storageNotConfigured: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchCalls[0]?.input)).toBe("https://api.example.com/api/latest/source-maps/artifacts");
    const registrationHeaders = new Headers(fetchCalls[0]?.init?.headers);
    expect(registrationHeaders.get("idempotency-key")).toBe(plan.manifestSha256);
    expect(registrationHeaders.get("x-stack-secret-server-key")).toBe("ssk_test");
    expect(String(fetchCalls[1]?.input)).toBe("https://storage.example/bundle");
    expect(String(fetchCalls[2]?.input)).toBe("https://storage.example/map");
    const bundleHeaders = new Headers(fetchCalls[1]?.init?.headers);
    expect(bundleHeaders.get("content-type")).toBe("application/javascript");
    expect(bundleHeaders.get("content-length")).toBe(String(artifact.bundleBytes));
    expect(bundleHeaders.get("if-none-match")).toBe("*");
    expect(bundleHeaders.get("x-stack-secret-server-key")).toBeNull();
    const mapHeaders = new Headers(fetchCalls[2]?.init?.headers);
    expect(mapHeaders.get("content-type")).toBe("application/json");
    expect(mapHeaders.get("content-encoding")).toBe("gzip");
    expect(mapHeaders.get("content-length")).toBe(String(artifact.sourceMapGzipped.length));
    expect(mapHeaders.get("if-none-match")).toBe("*");
    const uploadedBundle = new Uint8Array(await new Response(fetchCalls[1]?.init?.body).arrayBuffer());
    expect(uploadedBundle.byteLength).toBe(artifact.bundleBytes);
    expect(new TextDecoder().decode(uploadedBundle)).toContain(artifact.debugId);
    const uploadedMap = new Uint8Array(await new Response(fetchCalls[2]?.init?.body).arrayBuffer());
    expect(Array.from(uploadedMap)).toEqual(Array.from(artifact.sourceMapGzipped));
    expect(String(fetchCalls[3]?.input)).toBe("https://api.example.com/api/latest/source-maps/artifacts/finalize");
  });

  it("does not retry a permanent object-storage rejection and exposes a typed HTTP failure", async () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }).artifacts;
    const artifact = artifacts.at(0);
    if (artifact === undefined) throw new Error("fixture did not produce an artifact");
    const requestInput = {
      auth: {
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://app.example.com",
        publishableClientKey: "pck_test",
        projectId: "project-test",
        secretServerKey: "ssk_test",
      },
      getAuthHeaders: async () => ({ "x-stack-secret-server-key": "ssk_test" }),
      release: "v1",
      dist: null,
      environment: null,
      artifacts,
    };
    const plan = createSourceMapUploadPlan(requestInput);
    const fetchMock = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "registered",
        finalize_path: "/api/latest/source-maps/artifacts/finalize",
        artifacts: [{
          debug_id: artifact.debugId,
          code_file: artifact.bundleRelativePath,
          source_map_file: artifact.sourceMapRelativePath,
          bundle_object_key: "bundles/bundle.js",
          bundle_upload_url: "https://storage.example/bundle",
          source_map_object_key: "maps/map.json.gz",
          source_map_upload_url: "https://storage.example/map",
          already_finalized: false,
        }],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response("payload too large", { status: 413 }));
    const request: SourceMapUploadRequest = {
      ...requestInput,
      plan,
      transport: { fetch: fetchMock, sleep: async () => undefined },
    };

    await expect(uploadPreparedSourceMaps(request)).rejects.toMatchObject({
      name: "SourceMapUploadHttpError",
      status: 413,
      operation: `bundle ${artifact.bundleRelativePath}`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 412 from object storage as already-uploaded and still finalizes", async () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }).artifacts;
    const artifact = artifacts.at(0);
    if (artifact === undefined) throw new Error("fixture did not produce an artifact");
    const requestInput = {
      auth: {
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://app.example.com",
        publishableClientKey: "pck_test",
        projectId: "project-test",
        secretServerKey: "ssk_test",
      },
      getAuthHeaders: async () => ({}),
      release: "v1",
      dist: null,
      environment: null,
      artifacts,
    };
    const plan = createSourceMapUploadPlan(requestInput);
    const fetchMock = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "registered",
        finalize_path: "/api/latest/source-maps/artifacts/finalize",
        artifacts: [{
          debug_id: artifact.debugId,
          code_file: artifact.bundleRelativePath,
          source_map_file: artifact.sourceMapRelativePath,
          bundle_object_key: "bundles/bundle.js",
          bundle_upload_url: "https://storage.example/bundle",
          source_map_upload_url: "https://storage.example/map",
          source_map_object_key: "maps/map.json.gz",
          already_finalized: false,
        }],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response("precondition failed", { status: 412 }))
      .mockResolvedValueOnce(new Response("precondition failed", { status: 412 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "finalized",
        uploaded: [artifact.debugId],
        already_uploaded: [],
        catalog_status: "published",
      }), { status: 200 }));

    const result = await uploadPreparedSourceMaps({
      ...requestInput,
      plan,
      transport: { fetch: fetchMock, sleep: async () => undefined },
    });

    expect(result.uploaded).toEqual([artifact.debugId]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a malformed registration response before uploading any object", async () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }).artifacts;
    const requestInput = {
      auth: {
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://app.example.com",
        publishableClientKey: "pck_test",
        projectId: "project-test",
        secretServerKey: "ssk_test",
      },
      getAuthHeaders: async () => ({}),
      release: "v1",
      dist: null,
      environment: null,
      artifacts,
    };
    const plan = createSourceMapUploadPlan(requestInput);
    const fetchMock = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>().mockResolvedValue(new Response(JSON.stringify({
      manifest_sha256: plan.manifestSha256,
      status: "registered",
      finalize_path: "/api/latest/source-maps/artifacts/finalize",
      artifacts: [],
    }), { status: 201 }));

    await expect(uploadPreparedSourceMaps({
      ...requestInput,
      plan,
      transport: { fetch: fetchMock, sleep: async () => undefined },
    })).rejects.toBeInstanceOf(SourceMapUploadProtocolError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-upload an already-finalized manifest", async () => {
    const dir = makeTempDir();
    writeFile(dir, "static/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
    writeFile(dir, "static/main.js.map", FIXTURE_MAP_TEXT);
    const artifacts = prepareArtifacts(collectArtifacts([path.join(dir, "static")]), { repoRoot: dir, dryRun: false }).artifacts;
    const artifact = artifacts.at(0);
    if (artifact === undefined) throw new Error("fixture did not produce an artifact");
    const requestInput = {
      auth: {
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://app.example.com",
        publishableClientKey: "pck_test",
        projectId: "project-test",
        secretServerKey: "ssk_test",
      },
      getAuthHeaders: async () => ({}),
      release: "v1",
      dist: null,
      environment: null,
      artifacts,
    };
    const plan = createSourceMapUploadPlan(requestInput);
    const fetchMock = vi.fn<[string | URL | Request, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "already_registered",
        finalize_path: "/api/latest/source-maps/artifacts/finalize",
        artifacts: [{
          debug_id: artifact.debugId,
          code_file: artifact.bundleRelativePath,
          source_map_file: artifact.sourceMapRelativePath,
          bundle_object_key: "bundles/bundle.js",
          bundle_upload_url: "https://storage.example/bundle",
          source_map_object_key: "maps/map.json.gz",
          source_map_upload_url: "https://storage.example/map",
          already_finalized: true,
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        manifest_sha256: plan.manifestSha256,
        status: "already_finalized",
        uploaded: [],
        already_uploaded: [artifact.debugId],
        catalog_status: "already_published",
      }), { status: 200 }));

    const result = await uploadPreparedSourceMaps({
      ...requestInput,
      plan,
      transport: { fetch: fetchMock, sleep: async () => undefined },
    });

    expect(result.uploaded).toEqual([]);
    expect(result.alreadyUploaded).toEqual([artifact.debugId]);
    expect(result.catalogStatus).toBe("already_published");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails before auth when the project is not configured", async () => {
    const saved = new Map<string, string | undefined>([
      ["HEXCLAVE_PROJECT_ID", process.env.HEXCLAVE_PROJECT_ID],
      ["STACK_PROJECT_ID", process.env.STACK_PROJECT_ID],
    ]);
    for (const key of saved.keys()) delete process.env[key];
    try {
      const dir = makeTempDir();
      const bundlePath = writeFile(dir, ".next/static/chunks/main.js", FIXTURE_BUNDLE.replace("minified-chunk.js.map", "main.js.map"));
      writeFile(dir, ".next/static/chunks/main.js.map", FIXTURE_MAP_TEXT);
      const before = fs.readFileSync(bundlePath, "utf-8");

      await expect(run(["sourcemaps", "upload", path.join(dir, ".next")])).rejects.toThrow(/No project ID provided/);
      expect(fs.readFileSync(bundlePath, "utf-8")).toBe(before);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
