// The line regexes and the `filenameIsInApp` logic in this file were ported from
// sentry-javascript, which in turn forked them from TraceKit and node-stack-trace.
// They are MIT licensed and attribution is required; the notices follow verbatim.
//
// ---------------------------------------------------------------------------
// Originally forked from https://github.com/csnover/TraceKit, and was largely
// re-written as part of raven-js.
//
// Copyright (c) 2013 Onur Can Cakmak onur.cakmak@gmail.com and all TraceKit contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the 'Software'), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify,
// merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
// OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// ---------------------------------------------------------------------------
// Originally forked from https://github.com/felixge/node-stack-trace.
//
// Copyright (c) 2011 Felix Geisendörfer (felix@debuggable.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
// ---------------------------------------------------------------------------

import { isInAppPath } from "./in-app";
import type { ParsedFrame, StackPlatform } from "./types";


/**
 * Several of the regexes below backtrack, so their runtime grows exponentially
 * with the line length. Sentry hit real hangs over this
 * (getsentry/sentry-javascript#2286); truncating BEFORE the regex — not after —
 * is the entire mitigation.
 */
const MAX_LINE_LENGTH = 1024;
const MAX_FRAMES = 50;
const MAX_LINES_SCANNED = 500;


const CHROME_NO_FN_NAME_RE = /^\s*at (\S+?)(?::(\d+))(?::(\d+))\s*$/i;
const CHROME_RE = /^\s*at (?:(.+?\)(?: \[.+\])?|.*?) ?\((?:address at )?)?(?:async )?((?:<anonymous>|[-a-z]+:|.*bundle|\/)?.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;
const CHROME_EVAL_RE = /\((\S*)(?::(\d+))(?::(\d+))\)/;
const CHROME_DATA_URI_RE = /at (.+?) ?\(data:(.+?),/;

const GECKO_RE = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d+\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?\s*$/i;
const GECKO_EVAL_RE = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i;

const NODE_FULL_RE = /at (?:async )?(?:(.+?)\s+\()?(?:(.+):(\d+):(\d+)?|([^)]+))\)?/;
const NODE_DATA_URI_RE = /at (?:async )?(.+?) \(data:(.*?),/;

/** webpack wraps some rethrown errors as `(error: <real frame>)`. */
const WEBPACK_ERROR_WRAPPER_RE = /\(error: (.*)\)/;

/**
 * The first line of a V8 stack is `<Type>: <message>`, not a frame. Sentry only
 * skips lines containing the literal `"Error: "`, which misses every type that
 * does not spell it that way — `Invariant Violation:`, `AbortError:` inside a
 * sentence, and so on. That matters more here than it does in an SDK: the Gecko
 * regex happily matches a URL *inside the message*, so an unskipped header turns
 * the message's own URL into a frame, and any id in that URL then splits the
 * issue on every occurrence.
 *
 * Applied to the first line only — Gecko and Safari stacks have no header line
 * and their first line is a real frame. Bounded on both sides, so it cannot
 * backtrack.
 *
 * The optional bracketed group is for Node's coded errors
 * (`Error [ERR_MODULE_NOT_FOUND]: …`): without it the header falls through to
 * the Gecko fallback, which happily matches a filesystem path *inside the
 * message* and emits it as a synthetic frame — and since ERR_MODULE_NOT_FOUND
 * messages embed the importing file's path, that fake frame would split the
 * issue per call site.
 */
const HEADER_LINE_RE = /^[\w$. ]{0,64}(?:Error|Exception|Violation|Failure)[\w$.]{0,64}(?: \[[\w$. \-]{1,64}\])?\s*:\s/;
const FRAME_LINE_PREFIX_RE = /^\s*at\s/;


const URL_ORIGIN_RE = /^[a-zA-Z][a-zA-Z0-9.\-+]*:\/\//;
const WINDOWS_DRIVE_PREFIXED_RE = /^\/[a-zA-Z]:/;

const KNOWN_SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

/**
 * Turbopack names a chunk `<logical name>__<hash>._.js`. The extension is
 * already gone by the time we test this, hence the trailing `._`.
 */
const TURBOPACK_HASH_SUFFIX_RE = /_{1,2}[0-9a-f]{4,64}\._$/i;
/** Turbopack chunks that carry the `._` marker but no hash (e.g. `[turbopack]_runtime._.js`). */
const TURBOPACK_MARKER_SUFFIX_RE = /\._$/;
/**
 * webpack/Next name a chunk `<logical name>-<contenthash>.js`. The 8-char floor
 * matters: webpack's shortest `[contenthash]` slice in a Next build is 8, and
 * anything shorter would start eating real words that happen to be hex
 * (`-face`, `-added`), silently merging unrelated chunks.
 */
const WEBPACK_HASH_SUFFIX_RE = /[-_.][0-9a-f]{8,64}$/i;
const PURE_HASH_RE = /^[0-9a-f]{8,64}$/i;
const NEXT_STATIC_KNOWN_SUBDIRS = new Set(["chunks", "css", "media", "development", "runtime"]);

export function hasUrlOrigin(path: string): boolean {
  return URL_ORIGIN_RE.test(path);
}

export function stripContentHash(segment: string): string {
  let out = segment;
  if (TURBOPACK_HASH_SUFFIX_RE.test(out)) {
    out = out.replace(TURBOPACK_HASH_SUFFIX_RE, "");
  } else if (TURBOPACK_MARKER_SUFFIX_RE.test(out)) {
    out = out.replace(TURBOPACK_MARKER_SUFFIX_RE, "");
  }
  out = out.replace(WEBPACK_HASH_SUFFIX_RE, "");
  if (PURE_HASH_RE.test(out)) return "<hash>";
  return out === "" ? segment : out;
}

export function pathnameOf(path: string): string {
  let rest = path;
  const schemeMatch = URL_ORIGIN_RE.exec(rest);
  if (schemeMatch !== null) {
    const afterScheme = rest.slice(schemeMatch[0].length);
    const firstSlash = afterScheme.indexOf("/");
    rest = firstSlash === -1 ? "" : afterScheme.slice(firstSlash);
  }
  const queryOrHash = rest.search(/[?#]/);
  if (queryOrHash !== -1) rest = rest.slice(0, queryOrHash);
  return rest;
}

function knownExtensionOf(segment: string): string {
  const lowered = segment.toLowerCase();
  return KNOWN_SCRIPT_EXTENSIONS.find((extension) => lowered.endsWith(extension)) ?? "";
}

function splitExtension(segment: string): { stem: string, extension: string } {
  const extension = knownExtensionOf(segment);
  const withoutExtension = segment.slice(0, segment.length - extension.length);
  const stem = withoutExtension.toLowerCase().endsWith(".min")
    ? withoutExtension.slice(0, withoutExtension.length - ".min".length)
    : withoutExtension;
  return { stem, extension };
}

export function normalizeFilenameForGrouping(filename: string): string {
  const { stem, extension } = splitExtension(filename);
  if (stem === "") return filename;
  return `${stripContentHash(stem)}${extension}`;
}

function dropNextBuildIdSegment(segments: string[]): string[] {
  const nextIndex = segments.indexOf("_next");
  if (nextIndex === -1) return segments;
  if (segments.at(nextIndex + 1) !== "static") return segments;
  const candidate = segments.at(nextIndex + 2);
  if (candidate === undefined) return segments;
  if (NEXT_STATIC_KNOWN_SUBDIRS.has(candidate)) return segments;
  return [...segments.slice(0, nextIndex + 2), ...segments.slice(nextIndex + 3)];
}

/**
 * Derives a bundler-independent logical module name from a browser path.
 *
 * Grouping drops the `filename` leaf for any frame whose path has a URL origin
 * (see `grouping.ts`), which is nearly every browser frame — so without a module
 * a minified browser stack would be hashed on its minified function names alone.
 * This is what gives those frames something stable to hash.
 *
 * Node frames intentionally get no module: their paths are absolute and the
 * `filename` leaf already contributes there.
 */
export function deriveModule(absPath: string, platform: StackPlatform): string | null {
  if (platform === "node") return null;
  if (absPath.startsWith("<") || absPath.startsWith("[")) return null;

  const pathname = pathnameOf(absPath);
  // `.` segments come from webpack's `webpack:///./src/foo.js` scheme and carry
  // no information; dropping them makes a webpack module name line up with the
  // same file's name under any other bundler.
  const rawSegments = pathname.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (rawSegments.length === 0) return null;

  const segments = dropNextBuildIdSegment(rawSegments);
  const lastIndex = segments.length - 1;
  const last = segments.at(lastIndex);
  if (last === undefined) return null;
  segments[lastIndex] = stripContentHash(splitExtension(last).stem);

  const moduleName = segments.filter((segment) => segment !== "").join("/");
  return moduleName === "" ? null : moduleName;
}


type RawFrame = {
  path: string | null,
  func: string | null,
  lineno: number | null,
  colno: number | null,
};

function parseLineNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * Safari (web) extensions emit "frames-only" stacks where the extension origin
 * ends up inside the *function* slot rather than the filename slot, so the
 * frame would otherwise be attributed to the page instead of the extension.
 */
function extractSafariExtensionDetails(func: string | null, path: string | null): [string | null, string | null] {
  if (func === null) return [func, path];
  const isSafariExtension = func.includes("safari-extension");
  const isSafariWebExtension = func.includes("safari-web-extension");
  if (!isSafariExtension && !isSafariWebExtension) return [func, path];
  return [
    func.includes("@") ? (func.split("@").at(0) ?? null) : null,
    `${isSafariExtension ? "safari-extension" : "safari-web-extension"}:${path ?? ""}`,
  ];
}

function parseChromeLine(line: string): RawFrame | null {
  const dataUriMatch = CHROME_DATA_URI_RE.exec(line);
  if (dataUriMatch !== null) {
    return { path: `<data:${dataUriMatch.at(2) ?? ""}>`, func: emptyToNull(dataUriMatch.at(1)), lineno: null, colno: null };
  }

  const noFnParts = CHROME_NO_FN_NAME_RE.exec(line);
  if (noFnParts !== null) {
    return {
      path: emptyToNull(noFnParts.at(1)),
      func: null,
      lineno: parseLineNumber(noFnParts.at(2)),
      colno: parseLineNumber(noFnParts.at(3)),
    };
  }

  const parts = CHROME_RE.exec(line);
  if (parts === null) return null;

  let rawPath = parts.at(2);
  let rawLine = parts.at(3);
  let rawCol = parts.at(4);
  if (rawPath !== undefined && rawPath.startsWith("eval")) {
    const subMatch = CHROME_EVAL_RE.exec(rawPath);
    if (subMatch !== null) {
      rawPath = subMatch.at(1);
      rawLine = subMatch.at(2);
      rawCol = subMatch.at(3);
    }
  }

  const [func, path] = extractSafariExtensionDetails(emptyToNull(parts.at(1)), emptyToNull(rawPath));
  return { path, func, lineno: parseLineNumber(rawLine), colno: parseLineNumber(rawCol) };
}

function parseGeckoLine(line: string): RawFrame | null {
  const parts = GECKO_RE.exec(line);
  if (parts === null) return null;

  let rawFunc = parts.at(1);
  let rawPath = parts.at(3);
  let rawLine = parts.at(4);
  let rawCol = parts.at(5);

  if (rawPath !== undefined && rawPath.includes(" > eval")) {
    const subMatch = GECKO_EVAL_RE.exec(rawPath);
    if (subMatch !== null) {
      rawFunc = rawFunc !== undefined && rawFunc !== "" ? rawFunc : "eval";
      rawPath = subMatch.at(1);
      rawLine = subMatch.at(2);
      rawCol = undefined;
    }
  }

  const [func, path] = extractSafariExtensionDetails(emptyToNull(rawFunc), emptyToNull(rawPath));
  return { path, func, lineno: parseLineNumber(rawLine), colno: parseLineNumber(rawCol) };
}

function normalizeNodePath(path: string | undefined): string | undefined {
  let filename = path?.startsWith("file://") === true ? path.slice("file://".length) : path;
  if (filename !== undefined && WINDOWS_DRIVE_PREFIXED_RE.test(filename)) {
    filename = filename.slice(1);
  }
  return filename;
}

function safeDecodeUri(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function parseNodeLine(line: string): RawFrame | null {
  const dataUriMatch = NODE_DATA_URI_RE.exec(line);
  if (dataUriMatch !== null) {
    return { path: `<data:${dataUriMatch.at(2) ?? ""}>`, func: emptyToNull(dataUriMatch.at(1)), lineno: null, colno: null };
  }

  const lineMatch = NODE_FULL_RE.exec(line);
  if (lineMatch === null) return null;

  // V8 renders methods as `Type.method` / `Type.Module.method`. Sentry's port
  // splits that apart so an anonymous method (`Type.<anonymous>`) drops the
  // whole name rather than grouping every closure of that type together.
  let functionName = lineMatch.at(1);
  let method: string | undefined = undefined;
  if (functionName !== undefined && functionName !== "") {
    let methodStart = functionName.lastIndexOf(".");
    // The `> 0` guard reproduces Sentry's bracket indexing: at `methodStart <= 0`
    // they read a negative index (always `undefined`), whereas `String.at` would
    // wrap around to the end of the string and decrement wrongly.
    if (methodStart > 0 && functionName.at(methodStart - 1) === ".") methodStart--;
    if (methodStart > 0) {
      const object = functionName.slice(0, methodStart);
      method = functionName.slice(methodStart + 1);
      const objectEnd = object.indexOf(".Module");
      if (objectEnd > 0) functionName = functionName.slice(objectEnd + 1);
    }
  } else {
    functionName = undefined;
  }
  if (method === "<anonymous>") functionName = undefined;

  const isNative = lineMatch.at(5) === "native";
  let path = normalizeNodePath(lineMatch.at(2));
  const trailing = lineMatch.at(5);
  if ((path === undefined || path === "") && trailing !== undefined && !isNative) {
    path = trailing;
  }
  if (isNative && (path === undefined || path === "")) path = "native";

  return {
    path: path === undefined || path === "" ? null : safeDecodeUri(path),
    func: functionName === undefined || functionName === "" ? null : functionName,
    lineno: parseLineNumber(lineMatch.at(3)),
    colno: parseLineNumber(lineMatch.at(4)),
  };
}

function lineParsersFor(platform: StackPlatform): ReadonlyArray<(line: string) => RawFrame | null> {
  switch (platform) {
    // Chrome first: Gecko's regex is loose enough to half-match V8 lines.
    case "javascript": {
      return [parseChromeLine, parseGeckoLine];
    }
    // Node stacks are V8-shaped, but the node parser additionally understands
    // `native`, `Type.<anonymous>` and `file://` paths. Chrome/Gecko stay on as
    // a fallback because `onRequestError` also receives browser-shaped stacks.
    case "node": {
      return [parseNodeLine, parseChromeLine, parseGeckoLine];
    }
  }
}


const HEXCLAVE_SDK_PATH_PATTERNS = ["@hexclave/", "/hexclave-app/", "\\hexclave-app\\"];
const HEXCLAVE_SDK_FUNCTION_NAMES = new Set([
  "normalizeCapturedError",
  "buildErrorEventData",
  "buildErrorEventDataFromNormalized",
  "computeErrorFingerprint",
  "installClientErrorCapture",
  "installServerErrorMonitor",
]);

function isHexclaveSdkFrame(frame: ParsedFrame): boolean {
  const path = frame.absPath;
  if (path !== null && HEXCLAVE_SDK_PATH_PATTERNS.some((pattern) => path.includes(pattern))) return true;
  const func = frame.function;
  return func !== null && HEXCLAVE_SDK_FUNCTION_NAMES.has(func.split(".").at(-1) ?? func);
}


export function parseStack(stack: string, platform: StackPlatform): ParsedFrame[] {
  const parsers = lineParsersFor(platform);
  const lines = stack.split("\n");
  const frames: ParsedFrame[] = [];

  const lineCount = Math.min(lines.length, MAX_LINES_SCANNED);
  for (let index = 0; index < lineCount; index++) {
    let line = lines.at(index) ?? "";
    if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH);

    // Unwrap webpack's `(error: <frame>)` rethrow markers (getsentry/sentry-javascript#5459).
    if (WEBPACK_ERROR_WRAPPER_RE.test(line)) line = line.replace(WEBPACK_ERROR_WRAPPER_RE, "$1");

    // The header line (`TypeError: cannot read ...`) is not a frame. `includes`
    // rather than a regex for the general case, because a regex over every line
    // backtracks on long lines (getsentry/sentry-javascript#20052).
    if (line.includes("Error: ")) continue;
    if (index === 0 && !FRAME_LINE_PREFIX_RE.test(line) && HEADER_LINE_RE.test(line)) continue;

    for (const parser of parsers) {
      const raw = parser(line);
      if (raw === null) continue;
      frames.push(toParsedFrame(raw, platform));
      break;
    }

    if (frames.length >= MAX_FRAMES) break;
  }

  return stripSdkFramesAndReverse(frames);
}

function toParsedFrame(raw: RawFrame, platform: StackPlatform): ParsedFrame {
  const absPath = raw.path;
  if (absPath === null) {
    return { filename: null, function: raw.func, module: null, absPath: null, lineno: raw.lineno, colno: raw.colno, inApp: false };
  }
  const filename = hasUrlOrigin(absPath) ? pathnameOf(absPath) : absPath;
  return {
    filename: filename === "" ? absPath : filename,
    function: raw.func,
    module: deriveModule(absPath, platform),
    absPath,
    lineno: raw.lineno,
    colno: raw.colno,
    inApp: isInAppPath(absPath, platform),
  };
}

function stripSdkFramesAndReverse(frames: ParsedFrame[]): ParsedFrame[] {
  let start = 0;
  while (start < frames.length) {
    const frame = frames.at(start);
    if (frame === undefined || !isHexclaveSdkFrame(frame)) break;
    start++;
  }
  const kept = start === frames.length ? [...frames] : frames.slice(start);
  kept.reverse();
  return kept;
}
