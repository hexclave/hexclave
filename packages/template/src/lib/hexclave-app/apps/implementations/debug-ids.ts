import { type DebugImage, ERROR_MAX_DEBUG_IMAGES, ERROR_MAX_DEBUG_IMAGES_BYTES } from "@hexclave/shared/dist/utils/analytics-wire";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { runtimeGlobals } from "./runtime-globals";


const DEBUG_IDS_GLOBAL_KEY = "_hexclaveDebugIds";

/**
 * Pulls the file location out of the innermost resolvable frame of a stack.
 *
 * Handles, in one pass over the lines:
 *  - V8 with a function name:  `    at fn (https://x/a.js:1:2)`
 *  - V8 without one:           `    at https://x/a.js:1:2`
 *  - SpiderMonkey / JSC:       `fn@https://x/a.js:1:2`, `@https://x/a.js:1:2`
 *  - Bare filesystem paths:    `    at fn (/var/task/.next/server/chunks/1.js:1:2)`
 *    Node stacks are absolute paths, not URLs, and server chunks are exactly
 *    the case source maps are hardest to get for — dropping them would silently
 *    make server-side symbolication impossible.
 *  - Windows paths:            `    at fn (C:\app\.next\server\x.js:1:2)`
 *
 * Frames with no location at all (`at <anonymous>`, `at Module._compile`) are
 * skipped rather than aborting, so "innermost" means "innermost frame we can
 * actually name a file for". Returns null when no line yields one.
 */
export function extractInnermostFrameFilename(stack: string): string | null {
  for (const line of stack.split("\n")) {
    const match = /(?:\bat\s+|[(@])((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/{2,3}|\/|[a-zA-Z]:[\\/])[^()]*?):\d+(?::\d+)?\)?\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

function readDebugIdsGlobal(): Record<string, unknown> | null {
  try {
    const value = runtimeGlobals[DEBUG_IDS_GLOBAL_KEY];
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

let cachedSource: Record<string, unknown> | null = null;
let cachedEntries: readonly (readonly [string, unknown])[] | null = null;
let cachedMap: ReadonlyMap<string, string> | null = null;

function resetDebugIdCache(): void {
  cachedSource = null;
  cachedEntries = null;
  cachedMap = null;
}

/**
 * `filename -> debug id` for every chunk that has registered itself, memoized.
 *
 * Cache validity is checked EXACTLY: same global object identity, same key
 * count, and every previously seen key still holds the identical value. The
 * value re-reads are O(chunks) cheap property gets; what the memo actually
 * avoids is re-running the frame regex over every full stack-string key. A
 * count-only check would be almost always sufficient (the snippet only ever
 * adds keys, and ids are derived from chunk bytes), but a dev-server rebuild
 * can re-serve the same URL with a same-shaped stack key and a NEW id — the
 * value comparison catches that overwrite instead of serving a stale id.
 * (A removed-and-replaced key at the same count is caught too: the removed
 * cached key now reads `undefined`, which mismatches its cached value.)
 */
export function getFilenameToDebugIdMap(): ReadonlyMap<string, string> {
  try {
    const debugIds = readDebugIdsGlobal();
    if (debugIds === null) {
      resetDebugIdCache();
      return new Map();
    }
    const keys = Object.keys(debugIds);
    if (
      cachedMap !== null
      && cachedSource === debugIds
      && cachedEntries !== null
      && keys.length === cachedEntries.length
      && cachedEntries.every(([key, value]) => debugIds[key] === value)
    ) {
      return cachedMap;
    }

    const map = new Map<string, string>();
    const entries: (readonly [string, unknown])[] = [];
    for (const key of keys) {
      const debugId = debugIds[key];
      entries.push([key, debugId]);
      if (typeof debugId !== "string" || debugId === "") continue;
      const filename = extractInnermostFrameFilename(key);
      if (filename === null) continue;
      map.set(filename, debugId);
    }

    cachedSource = debugIds;
    cachedEntries = entries;
    cachedMap = map;
    return map;
  } catch {
    resetDebugIdCache();
    return new Map();
  }
}

const textEncoder = new TextEncoder();

/**
 * First occurrence of `codeFile` in `stack` that reads as a complete frame
 * location, i.e. is immediately followed by `:<line digit>`. A bare
 * `String.includes` could bind a registered filename to a frame whose location
 * merely STARTS with it (`https://x/app.js` inside `https://x/app.js.old:1:1`,
 * or an unversioned URL prefixing a versioned one), attaching the wrong debug
 * id — and therefore symbolicating with the wrong source map. Every engine
 * writes frame locations as `<file>:<line>[:<col>]`, so requiring the `:digit`
 * boundary is exact without any per-frame parsing.
 */
function indexOfFrameLocation(stack: string, codeFile: string): number {
  let from = 0;
  while (true) {
    const index = stack.indexOf(codeFile, from);
    if (index < 0) return -1;
    const end = index + codeFile.length;
    const lineStart = stack.lastIndexOf("\n", index - 1) + 1;
    const linePrefix = stack.slice(lineStart, index);
    const hasFrameDelimiter = linePrefix.endsWith("at ")
      || linePrefix.endsWith("(")
      || linePrefix.endsWith("@");
    if (hasFrameDelimiter && stack.charCodeAt(end) === 0x3a) {
      const digit = stack.charCodeAt(end + 1);
      if (digit >= 0x30 && digit <= 0x39) return index;
    }
    from = index + 1;
  }
}

/**
 * The `debug_images` to attach to one `$error`: the registered chunks whose
 * filename occurs as a frame location in THIS error's stack, innermost first.
 *
 * Matching is a substring scan with a `:line` boundary check against the
 * (already truncated) stack — no parsing, no per-frame work. Ordering is by
 * first occurrence so that when either cap trims the list, the frames nearest
 * the throw site — the ones a human opens first — are the ones that survive.
 * Both caps `break` rather than `continue` for the same reason: skipping a
 * long entry to squeeze in a shorter outer one would silently reorder
 * usefulness.
 */
export function getDebugImagesForStack(stack: string | null): DebugImage[] {
  if (stack === null || stack === "") return [];
  const filenameToDebugId = getFilenameToDebugIdMap();
  if (filenameToDebugId.size === 0) return [];

  const matches: { index: number, image: DebugImage }[] = [];
  for (const [codeFile, debugId] of filenameToDebugId) {
    const index = indexOfFrameLocation(stack, codeFile);
    if (index < 0) continue;
    matches.push({ index, image: { code_file: codeFile, debug_id: debugId } });
  }
  matches.sort((a, b) => a.index - b.index);

  const images: DebugImage[] = [];
  let bytes = 2;
  for (const { image } of matches) {
    if (images.length >= ERROR_MAX_DEBUG_IMAGES) break;
    const entryBytes = textEncoder.encode(JSON.stringify(image)).length + (images.length > 0 ? 1 : 0);
    if (bytes + entryBytes > ERROR_MAX_DEBUG_IMAGES_BYTES) break;
    bytes += entryBytes;
    images.push(image);
  }
  return images;
}
