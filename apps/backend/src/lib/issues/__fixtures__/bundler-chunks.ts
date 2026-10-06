import type { GroupingInput } from "../types";


export const WEBPACK_CHUNK_NAMES_BUILD_A = [
  "/_next/static/chunks/4711-9f2c1ad3e4b57c60.js",
  "/_next/static/chunks/app/dashboard/page-b2c3d4e5f6a17890.js",
  "/_next/static/chunks/main-app-1c0f0d3b9a7e4f21.js",
  "/_next/static/chunks/webpack-8f9a0b1c2d3e4f56.js",
  "/_next/static/chunks/pages/_app-0011223344556677.js",
  "/_next/static/aB3kD9fQzLm1pR7sT2uV/_buildManifest.js",
] as const;

export const WEBPACK_CHUNK_NAMES_BUILD_B = [
  "/_next/static/chunks/4711-00ffaa1122334455.js",
  "/_next/static/chunks/app/dashboard/page-99887766554433aa.js",
  "/_next/static/chunks/main-app-abcdef0123456789.js",
  "/_next/static/chunks/webpack-1234abcd5678ef90.js",
  "/_next/static/chunks/pages/_app-fedcba9876543210.js",
  "/_next/static/zZ9yY8xX7wW6vV5uU4tT/_buildManifest.js",
] as const;

export const TURBOPACK_CHUNK_NAMES_BUILD_A = [
  "/_next/static/chunks/[root-of-the-server]__a1b2c3._.js",
  "/_next/static/chunks/src_app_dashboard_page_tsx_1a2b3c._.js",
  "/_next/static/chunks/[turbopack]_browser_dev_hmr-client_hmr-client_ts_4d5e6f._.js",
  "/_next/static/chunks/node_modules_next_dist_client_7a8b9c._.js",
] as const;

export const TURBOPACK_CHUNK_NAMES_BUILD_B = [
  "/_next/static/chunks/[root-of-the-server]__ff00aa._.js",
  "/_next/static/chunks/src_app_dashboard_page_tsx_0d1e2f._.js",
  "/_next/static/chunks/[turbopack]_browser_dev_hmr-client_hmr-client_ts_9c8b7a._.js",
  "/_next/static/chunks/node_modules_next_dist_client_112233._.js",
] as const;

export function buildRebuildFixture(
  chunkNames: readonly string[],
  options?: { message?: string, type?: string, columnOffset?: number },
): GroupingInput {
  const origin = "https://app.example.com";
  const functionNames = ["o", "u", "i", "s", "c", "l"];
  const columnOffset = options?.columnOffset ?? 0;
  const stackLines = chunkNames.map((chunk, index) => {
    const functionName = functionNames.at(index % functionNames.length) ?? "o";
    return `    at ${functionName} (${origin}${chunk}:1:${1000 + index + columnOffset})`;
  });
  const type = options?.type ?? "TypeError";
  const message = options?.message ?? "e.map is not a function";
  return {
    type,
    message,
    platform: "javascript",
    stack: [`${type}: ${message}`, ...stackLines].join("\n"),
  };
}
