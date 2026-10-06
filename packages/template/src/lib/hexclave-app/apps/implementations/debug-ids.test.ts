import { CUSTOM_TELEMETRY_MAX_ITEM_DATA_BYTES, ERROR_MAX_DEBUG_IMAGES, ERROR_MAX_DEBUG_IMAGES_BYTES } from "@hexclave/shared/dist/utils/analytics-wire";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { extractInnermostFrameFilename, getDebugImagesForStack, getFilenameToDebugIdMap } from "./debug-ids";
import { buildErrorEventData } from "./error-capture";

const GLOBAL_KEY = "_hexclaveDebugIds";

function setDebugIdsGlobal(value: unknown): void {
  Reflect.set(globalThis, GLOBAL_KEY, value);
}

function clearDebugIdsGlobal(): void {
  Reflect.deleteProperty(globalThis, GLOBAL_KEY);
}

function snippetStack(file: string): string {
  return `Error\n    at ${file}:1:76\n    at ${file}:1:132\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)`;
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(4, "0");
  return `0000${hex}-0000-4000-8000-00000000${hex}`;
}

afterEach(() => {
  clearDebugIdsGlobal();
  getFilenameToDebugIdMap();
});

describe("extractInnermostFrameFilename", () => {
  it("reads the V8 parenthesized form", () => {
    expect(extractInnermostFrameFilename("Error: boom\n    at fn (https://app.example.com/a.js:1:2)")).toBe("https://app.example.com/a.js");
  });

  it("reads the V8 bare form (no function name)", () => {
    expect(extractInnermostFrameFilename("Error\n    at https://app.example.com/a.js:1:76")).toBe("https://app.example.com/a.js");
  });

  it("reads SpiderMonkey/JSC `fn@url` and bare `@url` frames", () => {
    expect(extractInnermostFrameFilename("greet@https://app.example.com/a.js:1:2")).toBe("https://app.example.com/a.js");
    expect(extractInnermostFrameFilename("@https://app.example.com/a.js:1:2")).toBe("https://app.example.com/a.js");
  });

  it("reads bare absolute filesystem paths (Node stacks are paths, not URLs)", () => {
    expect(extractInnermostFrameFilename("Error\n    at fn (/var/task/.next/server/chunks/1.js:1:2)")).toBe("/var/task/.next/server/chunks/1.js");
    expect(extractInnermostFrameFilename("Error\n    at /var/task/.next/server/chunks/1.js:1:76")).toBe("/var/task/.next/server/chunks/1.js");
  });

  it("reads Windows drive-letter paths", () => {
    expect(extractInnermostFrameFilename("Error\n    at fn (C:\\app\\.next\\server\\x.js:1:2)")).toBe("C:\\app\\.next\\server\\x.js");
  });

  it("keeps the port of a localhost URL out of the line/column split", () => {
    expect(extractInnermostFrameFilename("Error\n    at fn (http://localhost:3000/_next/static/chunks/main.js:12:34)")).toBe("http://localhost:3000/_next/static/chunks/main.js");
  });

  it("allows whitespace inside the path (builds under directories with spaces)", () => {
    expect(extractInnermostFrameFilename("Error\n    at fn (/Users/dev/My Projects/app.nosync /4/.next/server/chunks/1.js:1:2)")).toBe("/Users/dev/My Projects/app.nosync /4/.next/server/chunks/1.js");
    expect(extractInnermostFrameFilename("Error\n    at fn (C:\\Program Files\\app\\x.js:1:2)")).toBe("C:\\Program Files\\app\\x.js");
    expect(extractInnermostFrameFilename("fn@https://app.example.com/a%20b/c.js:1:2")).toBe("https://app.example.com/a%20b/c.js");
  });

  it("accepts a frame with a line but no column", () => {
    expect(extractInnermostFrameFilename("Error\n    at https://app.example.com/a.js:11")).toBe("https://app.example.com/a.js");
  });

  it("takes the INNERMOST resolvable frame, skipping locationless ones", () => {
    const stack = [
      "Error: boom",
      "    at <anonymous>",
      "    at async Promise.all (index 0)",
      "    at inner (https://app.example.com/inner.js:1:2)",
      "    at outer (https://app.example.com/outer.js:9:9)",
    ].join("\n");
    expect(extractInnermostFrameFilename(stack)).toBe("https://app.example.com/inner.js");
  });

  it("returns null when no frame names a file", () => {
    expect(extractInnermostFrameFilename("Error: boom")).toBeNull();
    expect(extractInnermostFrameFilename("")).toBeNull();
    expect(extractInnermostFrameFilename("Error\n    at node:internal/process/execution:451:12")).toBeNull();
  });

  it("round-trips a stack produced by real code running inside a named file", () => {
    const filename = "https://app.example.com/_next/static/chunks/main-abc123.js";
    const context: { recorded: unknown } = { recorded: null };
    vm.createContext(context);
    vm.runInContext("recorded = new Error().stack;", context, { filename });
    expect(typeof context.recorded).toBe("string");
    expect(extractInnermostFrameFilename(String(context.recorded))).toBe(filename);
  });
});

describe("getFilenameToDebugIdMap", () => {
  it("returns an empty map when the global is absent or not an object", () => {
    expect(getFilenameToDebugIdMap().size).toBe(0);
    setDebugIdsGlobal("nope");
    expect(getFilenameToDebugIdMap().size).toBe(0);
    setDebugIdsGlobal([]);
    expect(getFilenameToDebugIdMap().size).toBe(0);
  });

  it("collapses full stack keys down to one filename each", () => {
    setDebugIdsGlobal({
      [snippetStack("https://app.example.com/a.js")]: uuid(1),
      [snippetStack("/var/task/.next/server/chunks/b.js")]: uuid(2),
    });
    expect([...getFilenameToDebugIdMap()]).toEqual([
      ["https://app.example.com/a.js", uuid(1)],
      ["/var/task/.next/server/chunks/b.js", uuid(2)],
    ]);
  });

  it("ignores non-string values and keys with no resolvable frame", () => {
    setDebugIdsGlobal({
      [snippetStack("https://app.example.com/a.js")]: 42,
      "no frames here": uuid(2),
      [snippetStack("https://app.example.com/c.js")]: "",
      [snippetStack("https://app.example.com/d.js")]: uuid(4),
    });
    expect([...getFilenameToDebugIdMap().keys()]).toEqual(["https://app.example.com/d.js"]);
  });

  it("memoizes on the global's key count, and invalidates when a chunk registers", () => {
    const registry: Record<string, string> = { [snippetStack("https://app.example.com/a.js")]: uuid(1) };
    setDebugIdsGlobal(registry);
    const first = getFilenameToDebugIdMap();
    expect(getFilenameToDebugIdMap()).toBe(first);

    registry[snippetStack("https://app.example.com/b.js")] = uuid(2);
    const second = getFilenameToDebugIdMap();
    expect(second).not.toBe(first);
    expect(second.size).toBe(2);
  });

  it("invalidates when the whole global is swapped for one of the same size", () => {
    setDebugIdsGlobal({ [snippetStack("https://app.example.com/a.js")]: uuid(1) });
    expect([...getFilenameToDebugIdMap().keys()]).toEqual(["https://app.example.com/a.js"]);
    setDebugIdsGlobal({ [snippetStack("https://app.example.com/b.js")]: uuid(2) });
    expect([...getFilenameToDebugIdMap().keys()]).toEqual(["https://app.example.com/b.js"]);
  });

  it("invalidates when an existing key's debug id is overwritten in place", () => {
    const key = snippetStack("https://app.example.com/a.js");
    const registry: Record<string, string> = { [key]: uuid(1) };
    setDebugIdsGlobal(registry);
    expect(getFilenameToDebugIdMap().get("https://app.example.com/a.js")).toBe(uuid(1));
    registry[key] = uuid(2);
    expect(getFilenameToDebugIdMap().get("https://app.example.com/a.js")).toBe(uuid(2));
  });

  it("returns an empty map when the global is a throwing accessor", () => {
    Object.defineProperty(globalThis, GLOBAL_KEY, {
      configurable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    expect(getFilenameToDebugIdMap().size).toBe(0);
  });

  it("returns an empty map when the global is a Proxy that throws on enumeration or reads", () => {
    setDebugIdsGlobal(new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    }));
    expect(getFilenameToDebugIdMap().size).toBe(0);
    setDebugIdsGlobal(new Proxy({ [snippetStack("https://app.example.com/a.js")]: uuid(1) }, {
      get() {
        throw new Error("hostile get");
      },
    }));
    expect(getFilenameToDebugIdMap().size).toBe(0);
  });
});

describe("getDebugImagesForStack", () => {
  it("returns nothing without a stack or without registered chunks", () => {
    expect(getDebugImagesForStack(null)).toEqual([]);
    expect(getDebugImagesForStack("Error\n    at https://app.example.com/a.js:1:2")).toEqual([]);
    setDebugIdsGlobal({ [snippetStack("https://app.example.com/a.js")]: uuid(1) });
    expect(getDebugImagesForStack("")).toEqual([]);
  });

  it("includes only the chunks whose filename occurs in THIS error's stack", () => {
    setDebugIdsGlobal({
      [snippetStack("https://app.example.com/used.js")]: uuid(1),
      [snippetStack("https://app.example.com/unused.js")]: uuid(2),
    });
    expect(getDebugImagesForStack("Error: boom\n    at fn (https://app.example.com/used.js:1:2)")).toEqual([
      { code_file: "https://app.example.com/used.js", debug_id: uuid(1) },
    ]);
  });

  it("requires a complete frame location, not a bare substring prefix", () => {
    setDebugIdsGlobal({
      [snippetStack("https://app.example.com/app.js")]: uuid(1),
    });
    expect(getDebugImagesForStack("Error: boom\n    at fn (https://app.example.com/app.js.old:1:2)")).toEqual([]);
    const stack = "Error: boom\n    at a (https://app.example.com/app.js.old:1:2)\n    at b (https://app.example.com/app.js:3:4)";
    expect(getDebugImagesForStack(stack)).toEqual([
      { code_file: "https://app.example.com/app.js", debug_id: uuid(1) },
    ]);
  });

  it("orders by first occurrence so the innermost frames survive trimming", () => {
    setDebugIdsGlobal({
      [snippetStack("https://app.example.com/outer.js")]: uuid(3),
      [snippetStack("https://app.example.com/middle.js")]: uuid(2),
      [snippetStack("https://app.example.com/inner.js")]: uuid(1),
    });
    const stack = [
      "Error: boom",
      "    at a (https://app.example.com/inner.js:1:2)",
      "    at b (https://app.example.com/middle.js:1:2)",
      "    at c (https://app.example.com/outer.js:1:2)",
    ].join("\n");
    expect(getDebugImagesForStack(stack).map((image) => image.code_file)).toEqual([
      "https://app.example.com/inner.js",
      "https://app.example.com/middle.js",
      "https://app.example.com/outer.js",
    ]);
  });

  it("respects the count cap", () => {
    const registry: Record<string, string> = {};
    const frames: string[] = ["Error: boom"];
    for (let i = 0; i < ERROR_MAX_DEBUG_IMAGES + 5; i++) {
      const file = `https://app.example.com/c${i}.js`;
      registry[snippetStack(file)] = uuid(i);
      frames.push(`    at f${i} (${file}:1:2)`);
    }
    setDebugIdsGlobal(registry);
    const images = getDebugImagesForStack(frames.join("\n"));
    expect(images.length).toBe(ERROR_MAX_DEBUG_IMAGES);
    expect(images[0].code_file).toBe("https://app.example.com/c0.js");
  });

  it("respects the byte cap before the count cap when filenames are long", () => {
    const registry: Record<string, string> = {};
    const frames: string[] = ["Error: boom"];
    for (let i = 0; i < ERROR_MAX_DEBUG_IMAGES; i++) {
      const file = `https://app.example.com/_next/static/chunks/${"segment".repeat(40)}-${i}.js`;
      registry[snippetStack(file)] = uuid(i);
      frames.push(`    at f${i} (${file}:1:2)`);
    }
    setDebugIdsGlobal(registry);
    const images = getDebugImagesForStack(frames.join("\n"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThan(ERROR_MAX_DEBUG_IMAGES);
    expect(new TextEncoder().encode(JSON.stringify(images)).length).toBeLessThanOrEqual(ERROR_MAX_DEBUG_IMAGES_BYTES);
  });
});

describe("buildErrorEventData with debug images", () => {
  it("omits debug_images entirely when there are none (present-when-set)", () => {
    const data = buildErrorEventData(new Error("boom"), {
      mechanismType: "captured",
      handled: true,
      release: null,
      environment: null,
      sdkVersion: "0.0.0-test",
      getDebugImages: () => [],
    });
    expect("debug_images" in data).toBe(false);
  });

  it("still builds the event (without images) when the registry global is hostile", () => {
    Object.defineProperty(globalThis, GLOBAL_KEY, {
      configurable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    const data = buildErrorEventData(new Error("boom"), {
      mechanismType: "captured",
      handled: true,
      release: null,
      environment: null,
      sdkVersion: "0.0.0-test",
    });
    expect(data.message).toBe("boom");
    expect("debug_images" in data).toBe(false);
  });

  it("attaches injected debug images without touching globals", () => {
    const data = buildErrorEventData(new Error("boom"), {
      mechanismType: "captured",
      handled: true,
      release: null,
      environment: null,
      sdkVersion: "0.0.0-test",
      getDebugImages: () => [{ code_file: "https://app.example.com/a.js", debug_id: uuid(1) }],
    });
    expect(data.debug_images).toEqual([{ code_file: "https://app.example.com/a.js", debug_id: uuid(1) }]);
  });

  it("stays under the item-data budget at worst case (max message + max stack + max debug images)", () => {
    const registry: Record<string, string> = {};
    const frames: string[] = [];
    for (let i = 0; i < ERROR_MAX_DEBUG_IMAGES + 10; i++) {
      const file = `https://app.example.com/_next/static/chunks/${"a".repeat(80)}-${i}.js`;
      registry[snippetStack(file)] = uuid(i);
      frames.push(`    at someRatherLongFunctionName${i} (${file}:12345:67890)`);
    }
    setDebugIdsGlobal(registry);

    const error = new Error("x".repeat(50_000));
    error.stack = `Error: boom\n${frames.join("\n")}\n${"    at padding (https://app.example.com/pad.js:1:1)\n".repeat(500)}`;

    const data = buildErrorEventData(error, {
      mechanismType: "node.uncaughtexception",
      handled: false,
      release: "1.2.3",
      environment: "production",
      sdkVersion: "0.0.0-test",
    });
    expect(Array.isArray(data.debug_images)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(CUSTOM_TELEMETRY_MAX_ITEM_DATA_BYTES);
  });
});
