import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadAsyncLocalStorage, resetAsyncLocalStorageCacheForTesting } from "./async-local-storage";

const sourcePath = fileURLToPath(new URL("./async-local-storage.tsx", import.meta.url));
const distPath = join(dirname(sourcePath), "../../dist/esm/utils/async-local-storage.js");

afterEach(() => {
  resetAsyncLocalStorageCacheForTesting();
});

describe("loadAsyncLocalStorage", () => {
  it("returns a working AsyncLocalStorage on Node", async () => {
    const als = await loadAsyncLocalStorage<{ n: number }>("test-als");
    expect(als).not.toBeNull();
    expect(als?.getStore()).toBeUndefined();
    const result = als?.run({ n: 7 }, () => als.getStore()?.n);
    expect(result).toBe(7);
    expect(als?.getStore()).toBeUndefined();
  });

  it("returns the same instance for the same key and a different instance for another", async () => {
    const first = await loadAsyncLocalStorage("same-key");
    const again = await loadAsyncLocalStorage("same-key");
    const other = await loadAsyncLocalStorage("other-key");
    expect(first).toBe(again);
    expect(other).not.toBe(first);
  });

  it("keeps the node:async_hooks specifier opaque so bundlers cannot see a Node builtin import", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toMatch(/\["node", "async_hooks"\]\.join\(":"\)/);
    expect(source).not.toMatch(/await import\([^;]*"node:async_hooks"/s);
    if (existsSync(distPath)) {
      const dist = readFileSync(distPath, "utf8");
      expect(dist).not.toMatch(/await import\(\s*(?:\/\*[^*]*\*\/\s*)*"node:async_hooks"/);
    }
  });
});
