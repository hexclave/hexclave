import { describe, expect, it, vi } from "vitest";
import { type GroupingConfigId } from "./grouping-config";
import { computeGrouping, computeGroupingWithReadableConfigs } from "./grouping";
import * as groupingFingerprint from "./grouping-fingerprint";
import type { GroupingInput, GroupingResult } from "./types";

const CONFIG: GroupingConfigId = "hexclave-js:2026-08-20";

function group(overrides: Partial<GroupingInput> & Pick<GroupingInput, "type" | "message">): GroupingResult {
  return computeGrouping({ platform: "javascript", stack: null, ...overrides }, CONFIG);
}

function appStack(options?: { type?: string, functionName?: string, file?: string, line?: number }): string {
  const type = options?.type ?? "TypeError";
  const functionName = options?.functionName ?? "renderRow";
  const file = options?.file ?? "https://app.example.com/static/js/table.js";
  const line = options?.line ?? 42;
  return [
    `${type}: something went wrong`,
    `    at ${functionName} (${file}:${line}:9)`,
    `    at Table (${file}:100:3)`,
  ].join("\n");
}

describe("computeGrouping — exception type is a leaf", () => {
  it("does not collapse a TypeError and a RangeError thrown from the same frame", () => {
    const typeError = group({ type: "TypeError", message: "x is not a function", stack: appStack({ type: "TypeError" }) });
    const rangeError = group({ type: "RangeError", message: "x is not a function", stack: appStack({ type: "RangeError" }) });
    expect(typeError.ownerHash).not.toBe(rangeError.ownerHash);
  });

  it("does collapse two occurrences of the same type from the same frame with different messages", () => {
    const first = group({ type: "TypeError", message: "user 1 is not a function", stack: appStack() });
    const second = group({ type: "TypeError", message: "user 99999 is not a function", stack: appStack() });
    expect(first.ownerHash).toBe(second.ownerHash);
  });
});

describe("computeGrouping — frame normalization", () => {
  it("ignores lineno and colno", () => {
    const first = group({ type: "TypeError", message: "boom", stack: appStack({ line: 42 }) });
    const second = group({ type: "TypeError", message: "boom", stack: appStack({ line: 4242 }) });
    expect(first.ownerHash).toBe(second.ownerHash);
  });

  it("ignores the URL origin, so localhost and production group together", () => {
    const local = group({ type: "TypeError", message: "boom", stack: appStack({ file: "http://localhost:3000/static/js/table.js" }) });
    const production = group({ type: "TypeError", message: "boom", stack: appStack({ file: "https://app.example.com/static/js/table.js" }) });
    expect(local.ownerHash).toBe(production.ownerHash);
  });

  it("splits on a different function in the same file", () => {
    const first = group({ type: "TypeError", message: "boom", stack: appStack({ functionName: "renderRow" }) });
    const second = group({ type: "TypeError", message: "boom", stack: appStack({ functionName: "renderHeader" }) });
    expect(first.ownerHash).not.toBe(second.ownerHash);
  });

  it("splits on the same function in a different file", () => {
    const first = group({ type: "TypeError", message: "boom", stack: appStack({ file: "https://app.example.com/static/js/table.js" }) });
    const second = group({ type: "TypeError", message: "boom", stack: appStack({ file: "https://app.example.com/static/js/list.js" }) });
    expect(first.ownerHash).not.toBe(second.ownerHash);
  });

  it("takes only the last segment of a dotted function name", () => {
    const dotted = group({ type: "TypeError", message: "boom", stack: appStack({ functionName: "Table.prototype.renderRow" }) });
    const bare = group({ type: "TypeError", message: "boom", stack: appStack({ functionName: "renderRow" }) });
    expect(dotted.ownerHash).toBe(bare.ownerHash);
  });

  it("prefers the module over the filename", () => {
    const first = group({ type: "TypeError", message: "boom", stack: appStack({ file: "https://cdn.example.com/static/js/table.js" }) });
    const second = group({ type: "TypeError", message: "boom", stack: appStack({ file: "https://app.example.com/static/js/table.js" }) });
    expect(first.ownerHash).toBe(second.ownerHash);
  });

  it("keeps Node directory identity while ignoring checkout roots", () => {
    const nodeStack = (file: string) => [
      "TypeError: boom",
      `    at loadConfig (${file}:42:9)`,
    ].join("\n");
    const source = group({ type: "TypeError", message: "boom", platform: "node", stack: nodeStack("/srv/checkout/src/auth/config.ts") });
    const sameSource = group({ type: "TypeError", message: "boom", platform: "node", stack: nodeStack("/tmp/another-checkout/src/auth/config.ts") });
    const differentDirectory = group({ type: "TypeError", message: "boom", platform: "node", stack: nodeStack("/srv/checkout/src/billing/config.ts") });

    expect(source.ownerHash).toBe(sameSource.ownerHash);
    expect(source.ownerHash).not.toBe(differentDirectory.ownerHash);
  });

  it("keeps the basename-only predecessor readable after the path-aware rollout", () => {
    const nodeStack = (file: string) => ["TypeError: boom", `    at loadConfig (${file}:42:9)`].join("\n");
    const input: GroupingInput = { type: "TypeError", message: "boom", platform: "node", stack: nodeStack("/srv/checkout/src/auth/config.ts") };
    const historical = computeGrouping(input, "hexclave-js:2026-08-01");
    const current = computeGroupingWithReadableConfigs(input, {
      activeConfigId: "hexclave-js:2026-08-20",
      readableConfigIds: ["hexclave-js:2026-08-01"],
      provenance: { active: "default", readable: "default" },
    });
    expect(current.ownerHash).not.toBe(historical.ownerHash);
    expect(current.aliasHashes).toContain(historical.ownerHash);
  });

  it("collapses consecutive identical frames so recursion depth does not split the issue", () => {
    const recursive = (depth: number) => [
      "RangeError: Maximum call stack size exceeded",
      ...Array.from({ length: depth }, () => "    at walk (https://app.example.com/static/js/tree.js:12:5)"),
      "    at render (https://app.example.com/static/js/tree.js:80:1)",
    ].join("\n");
    const shallow = group({ type: "RangeError", message: "Maximum call stack size exceeded", stack: recursive(3) });
    const deep = group({ type: "RangeError", message: "Maximum call stack size exceeded", stack: recursive(40) });
    expect(shallow.ownerHash).toBe(deep.ownerHash);
  });
});

describe("computeGrouping — app vs system variants", () => {
  const mixedStack = [
    "TypeError: cannot read properties of null",
    "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
    "    at commitLayoutEffects (https://app.example.com/node_modules/react-dom/index.js:23426:1)",
    "    at flushWork (https://app.example.com/node_modules/scheduler/index.js:100:1)",
  ].join("\n");

  it("prefers the app variant and keeps the system variant as an alias", () => {
    const result = group({ type: "TypeError", message: "cannot read properties of null", stack: mixedStack });
    expect({ variant: result.variant, aliasCount: result.aliasHashes.length }).toMatchInlineSnapshot(`
      {
        "aliasCount": 1,
        "variant": "app",
      }
    `);
    expect(result.aliasHashes.includes(result.ownerHash)).toBe(false);
  });

  it("groups two customer bugs that share a library tail as different issues", () => {
    const other = mixedStack.replace("renderRow", "renderHeader");
    const first = group({ type: "TypeError", message: "boom", stack: mixedStack });
    const second = group({ type: "TypeError", message: "boom", stack: other });
    expect(first.ownerHash).not.toBe(second.ownerHash);
  });

  it("groups the same customer bug reached through two different library paths together", () => {
    const viaScheduler = mixedStack;
    const viaEventHandler = [
      "TypeError: cannot read properties of null",
      "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
      "    at dispatchEvent (https://app.example.com/node_modules/react-dom/events.js:1:1)",
    ].join("\n");
    const first = group({ type: "TypeError", message: "boom", stack: viaScheduler });
    const second = group({ type: "TypeError", message: "boom", stack: viaEventHandler });
    expect(first.ownerHash).toBe(second.ownerHash);
    expect(first.aliasHashes).not.toEqual(second.aliasHashes);
  });

  it("falls back to the system variant when nothing is in-app", () => {
    const allLibrary = [
      "TypeError: boom",
      "    at commitLayoutEffects (https://app.example.com/node_modules/react-dom/index.js:23426:1)",
      "    at flushWork (https://app.example.com/node_modules/scheduler/index.js:100:1)",
    ].join("\n");
    const result = group({ type: "TypeError", message: "boom", stack: allLibrary });
    expect({ variant: result.variant, aliasHashes: result.aliasHashes }).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "variant": "system",
      }
    `);
  });

  it("emits no alias when every frame is in-app and the two variants agree", () => {
    const result = group({ type: "TypeError", message: "boom", stack: appStack() });
    expect(result.variant).toMatchInlineSnapshot(`"system"`);
    expect(result.aliasHashes).toMatchInlineSnapshot(`[]`);
  });

  it("zeroes non-app frames rather than removing them, so recursion collapse sees the original list", () => {
    const interleaved = [
      "TypeError: boom",
      "    at a (https://app.example.com/static/js/app.js:1:1)",
      "    at lib (https://app.example.com/node_modules/dep/index.js:1:1)",
      "    at a (https://app.example.com/static/js/app.js:2:1)",
      "    at lib (https://app.example.com/node_modules/dep/index.js:2:1)",
      "    at a (https://app.example.com/static/js/app.js:3:1)",
    ].join("\n");
    const single = [
      "TypeError: boom",
      "    at a (https://app.example.com/static/js/app.js:1:1)",
      "    at lib (https://app.example.com/node_modules/dep/index.js:1:1)",
    ].join("\n");
    expect(group({ type: "TypeError", message: "boom", stack: interleaved }).ownerHash)
      .not.toBe(group({ type: "TypeError", message: "boom", stack: single }).ownerHash);
  });
});

describe("computeGrouping — message fallback", () => {
  it("uses the parameterized message when there is no stack at all", () => {
    const first = group({ type: "Error", message: "Payment 12345 declined", stack: null });
    const second = group({ type: "Error", message: "Payment 67890 declined", stack: null });
    expect(first.variant).toMatchInlineSnapshot(`"message"`);
    expect(first.ownerHash).toBe(second.ownerHash);
    expect(first.culprit).toMatchInlineSnapshot(`"<unknown>"`);
  });

  it("uses the message when every frame is anonymous", () => {
    const result = group({
      type: "Error",
      message: "boom",
      stack: ["Error: boom", "    at <anonymous>:1:1", "    at Array.forEach (<anonymous>)"].join("\n"),
    });
    expect(result.variant).toMatchInlineSnapshot(`"system"`);
  });

  it("keeps two different message shapes apart", () => {
    const first = group({ type: "Error", message: "Payment declined", stack: null });
    const second = group({ type: "Error", message: "Payment refunded", stack: null });
    expect(first.ownerHash).not.toBe(second.ownerHash);
  });
});

describe("computeGrouping — synthetic throws", () => {
  const syntheticStack = ["Error", "    at https://app.example.com/static/js/app.js:1:9042"].join("\n");

  it("keeps distinct non-Error throws distinct", () => {
    const stringThrow = group({ type: "Error", message: "Non-Error exception captured: nope", stack: syntheticStack, synthetic: true });
    const objectThrow = group({ type: "Error", message: "Non-Error exception captured with keys: code", stack: syntheticStack, synthetic: true });
    expect(stringThrow.ownerHash).not.toBe(objectThrow.ownerHash);
  });

  it("still parameterizes, so an id in the synthesized message does not split", () => {
    const first = group({ type: "Error", message: "Non-Error exception captured: order 111", stack: syntheticStack, synthetic: true });
    const second = group({ type: "Error", message: "Non-Error exception captured: order 222", stack: syntheticStack, synthetic: true });
    expect(first.ownerHash).toBe(second.ownerHash);
  });

  it("does not collide with the non-synthetic grouping of the same payload", () => {
    const synthetic = group({ type: "Error", message: "boom", stack: syntheticStack, synthetic: true });
    const real = group({ type: "Error", message: "boom", stack: syntheticStack, synthetic: false });
    expect(synthetic.ownerHash).not.toBe(real.ownerHash);
  });

  it("splits on the throwing file", () => {
    const fromApp = group({ type: "Error", message: "boom", stack: syntheticStack, synthetic: true });
    const fromWorker = group({
      type: "Error",
      message: "boom",
      stack: ["Error", "    at https://app.example.com/static/js/worker.js:1:9042"].join("\n"),
      synthetic: true,
    });
    expect(fromApp.ownerHash).not.toBe(fromWorker.ownerHash);
  });
});

describe("computeGrouping — degraded fallback", () => {
  it("never returns an empty hash, whatever the input", () => {
    const inputs: GroupingInput[] = [
      { type: "", message: "", stack: null, platform: "javascript" },
      { type: "Error", message: "", stack: "", platform: "javascript" },
      { type: "Error", message: "\uD800", stack: "𐀀", platform: "node" },
      { type: "Error", message: "boom", stack: " ".repeat(1000), platform: "node" },
    ];
    for (const input of inputs) {
      const result = computeGrouping(input, CONFIG);
      expect(result.ownerHash).toHaveLength(32);
      expect(result.ownerHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("is deterministic and shares the message variant's encoding", () => {
    const messageVariant = group({ type: "Error", message: "Payment 1 declined", stack: null });
    const alsoMessageVariant = group({ type: "Error", message: "Payment 2 declined", stack: null });
    expect(messageVariant.ownerHash).toBe(alsoMessageVariant.ownerHash);
  });

  it("lets unexpected throws fail the occurrence write instead of degrading", () => {
    const spy = vi.spyOn(groupingFingerprint, "resolveGroupingFingerprint").mockImplementation(() => {
      throw new Error("unexpected fingerprint resolver bug");
    });
    expect(() => computeGrouping({
      type: "Error",
      message: "boom",
      stack: null,
      platform: "javascript",
    }, CONFIG)).toThrow("unexpected fingerprint resolver bug");
    spy.mockRestore();
  });

  it("rejects an unknown config id loudly instead of degrading", () => {
    const staleRowConfigId: GroupingConfigId = JSON.parse('"hexclave-js:1999-01-01"');
    expect(() => computeGrouping(
      { type: "Error", message: "boom", stack: null, platform: "javascript" },
      staleRowConfigId,
    )).toThrow(/Unknown grouping config id/);
  });
});

describe("computeGrouping — culprit", () => {
  it("names the last in-app frame, not the library frame that actually threw", () => {
    const result = group({
      type: "TypeError",
      message: "boom",
      stack: [
        "TypeError: boom",
        "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
        "    at commitLayoutEffects (https://app.example.com/node_modules/react-dom/index.js:23426:1)",
      ].join("\n"),
    });
    expect(result.culprit).toMatchInlineSnapshot(`"renderRow (/static/js/table.js)"`);
  });
});
