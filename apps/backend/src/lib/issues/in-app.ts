import type { StackPlatform } from "./types";

/**
 * The single source of truth for "is this frame the customer's own code?".
 *
 * Two consumers depend on this agreeing exactly: the ingest-time stack parser
 * (which stamps `inApp` onto every frame, feeding the `app` grouping variant)
 * and read-time symbolication (which re-derives `inApp` from the *original*
 * path recovered from a source map). If those two ever disagreed, a symbolicated
 * frame would render as in-app while the hash that owns it was computed from a
 * system frame — i.e. the UI would show a stack that cannot produce that issue.
 *
 * This is a hardcoded ruleset, not Sentry's user-configurable enhancer DSL. The
 * DSL is a large surface with its own parser and cache, and grouping does not
 * currently need per-project overrides.
 *
 * The node branch is ported from Sentry's `filenameIsInApp`
 * (`packages/core/src/utils/node-stack-trace.ts`), originally forked from
 * https://github.com/felixge/node-stack-trace — see the attribution header in
 * `stack-parser.ts`.
 */

const JAVASCRIPT_NOT_IN_APP_SUBSTRINGS = ["/node_modules/"];
const LEGACY_WEBPACK_MODULE_PATH_RE = /^webpack:\/\/(?:[^/]+)?\/\.\/~\//;
const JAVASCRIPT_NOT_IN_APP_PREFIXES = ["webpack-internal:", "node:"];
const NEXT_FRAMEWORK_CHUNK_PREFIX = "/_next/static/chunks/framework";

const NON_FILE_PATHS = new Set(["<anonymous>", "[native code]", "native", "<unknown>"]);

const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:/;
const NODE_MODULES_SEGMENT_RE = /(?:^|[\\/])node_modules[\\/]/;
// Schema from https://stackoverflow.com/a/3641782 — `scheme://`, i.e. the frame
// went through a bundler or came off the network rather than off disk.
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9.\-+]*:\/\//;

export function isInAppPath(path: string, platform: StackPlatform): boolean {
  if (path === "") return false;
  if (NON_FILE_PATHS.has(path)) return false;

  switch (platform) {
    case "javascript": {
      if (JAVASCRIPT_NOT_IN_APP_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
      if (JAVASCRIPT_NOT_IN_APP_SUBSTRINGS.some((needle) => path.includes(needle))) return false;
      if (LEGACY_WEBPACK_MODULE_PATH_RE.test(path)) return false;
      if (path.includes(NEXT_FRAMEWORK_CHUNK_PREFIX)) return false;
      return true;
    }
    case "node": {
      const isBuiltinOrBundled = !path.startsWith("/")
        && !WINDOWS_ABSOLUTE_PATH_RE.test(path)
        && !path.startsWith(".")
        && !URL_SCHEME_RE.test(path);
      if (isBuiltinOrBundled) return false;
      return !NODE_MODULES_SEGMENT_RE.test(path);
    }
  }
}
