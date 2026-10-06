import { describe, expect, it } from "vitest";
import { isInAppPath } from "./in-app";

describe("isInAppPath — javascript", () => {
  it.each([
    ["a bundled app chunk", "https://app.example.com/_next/static/chunks/app/page-a1b2c3d4.js", true],
    ["a plain app script", "https://app.example.com/static/js/main.js", true],
    ["a relative app path", "/src/components/Button.tsx", true],
    ["a dependency", "https://app.example.com/node_modules/.vite/deps/react.js", false],
    ["a nested dependency", "/srv/app/node_modules/react-dom/index.js", false],
    ["a webpack-internal module", "webpack-internal:///./src/app/page.tsx", false],
    ["a legacy webpack dependency marker", "webpack:///./~/react-proxy/modules/createPrototypeProxy.js", false],
    ["a namespaced legacy webpack dependency marker", "webpack://app/./~/react-proxy/modules/createPrototypeProxy.js", false],
    ["a node builtin leaking into a browser stack", "node:internal/process/task_queues", false],
    ["the Next framework chunk", "https://app.example.com/_next/static/chunks/framework-2c79e2a64abdb08b.js", false],
    ["the Next framework chunk without an origin", "/_next/static/chunks/framework-2c79e2a64abdb08b.js", false],
    ["an anonymous frame", "<anonymous>", false],
    ["a native frame", "[native code]", false],
    ["an unknown path", "", false],
  ])("%s", (_name, path, expected) => {
    expect(isInAppPath(path, "javascript")).toBe(expected);
  });
});

describe("isInAppPath — node", () => {
  it.each([
    ["an absolute posix app path", "/srv/app/src/app/api/users/route.ts", true],
    ["an absolute windows app path", "C:/app/src/route.ts", true],
    ["a relative app path", "./src/route.ts", true],
    ["a dependency", "/srv/app/node_modules/next/dist/server/module.js", false],
    ["a windows dependency with backslashes", "C:\\app\\node_modules\\pkg\\index.js", false],
    ["a windows app path with backslashes", "C:\\app\\src\\index.js", true],
    ["a node builtin", "node:internal/process/task_queues", false],
    ["a legacy node builtin", "internal/process/task_queues.js", false],
    ["a bare builtin", "events.js", false],
    ["a bundled frame with a file scheme", "file:///srv/app/.next/server/chunks/1.js", true],
    ["a bundled frame with a webpack scheme", "webpack://app/./src/route.ts", true],
    ["a bundled dependency", "webpack://app/./node_modules/next/index.js", false],
    ["a native frame", "native", false],
    ["an unknown path", "", false],
  ])("%s", (_name, path, expected) => {
    expect(isInAppPath(path, "node")).toBe(expected);
  });
});

describe("isInAppPath — the two rulesets are deliberately different", () => {
  it("treats a bare relative filename as app code on the browser but as a builtin on node", () => {
    expect([isInAppPath("route.ts", "javascript"), isInAppPath("route.ts", "node")]).toMatchInlineSnapshot(`
      [
        true,
        false,
      ]
    `);
  });
});
