import { describe, expect, it } from "vitest";
import { DEFAULT_GROUPING_CONFIG_ID } from "./grouping-config";
import {
  GROUPING_FINGERPRINT_TOKENS,
  classifyGroupingFingerprint,
  readGroupingFingerprint,
  resolveGroupingFingerprint,
} from "./grouping-fingerprint";
import { computeGrouping } from "./grouping";
import type { GroupingInput } from "./types";

const CONFIG = DEFAULT_GROUPING_CONFIG_ID;

const STACK = [
  "TypeError: row is null",
  "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
  "    at commitLayoutEffects (https://app.example.com/node_modules/react-dom/index.js:23426:1)",
].join("\n");

function input(overrides: Partial<GroupingInput> = {}): GroupingInput {
  return {
    type: "TypeError",
    message: "row is null",
    stack: STACK,
    platform: "javascript",
    ...overrides,
  };
}

describe("server-side custom fingerprint contract", () => {
  it("documents the supported default, type, message, and stack tokens", () => {
    expect(GROUPING_FINGERPRINT_TOKENS).toEqual([
      "{{ default }}",
      "{{ type }}",
      "{{ message }}",
      "{{ stack }}",
      "{{ stack.function }}",
      "{{ stack.filename }}",
      "{{ stack.abs_path }}",
      "{{ stack.module }}",
    ]);
  });

  it("preserves the existing hash when the default token is explicit", () => {
    const implicit = computeGrouping(input(), CONFIG);
    const explicit = computeGrouping(input({ fingerprint: ["{{ default }}"] }), CONFIG);

    expect(explicit.ownerHash).toBe(implicit.ownerHash);
    expect(explicit.aliasHashes).toEqual(implicit.aliasHashes);
    expect(explicit.variant).toBe(implicit.variant);
    expect(explicit.provenance.fingerprint).toEqual({
      type: "default",
      source: "default",
      tokens: ["{{ default }}"],
      resolvedTokens: [],
    });
  });

  it("uses type and parameterized message values for a custom owner", () => {
    const first = computeGrouping(input({
      stack: null,
      message: "Payment 12345 declined",
      fingerprint: ["{{ type }}", "{{ message }}"],
    }), CONFIG);
    const sameParameterizedMessage = computeGrouping(input({
      stack: null,
      message: "Payment 67890 declined",
      fingerprint: ["{{ type }}", "{{ message }}"],
    }), CONFIG);
    const otherType = computeGrouping(input({
      stack: null,
      type: "RangeError",
      message: "Payment 67890 declined",
      fingerprint: ["{{ type }}", "{{ message }}"],
    }), CONFIG);

    expect(first.variant).toBe("custom");
    expect(first.aliasHashes).toEqual([]);
    expect(first.ownerHash).toBe(sameParameterizedMessage.ownerHash);
    expect(first.ownerHash).not.toBe(otherType.ownerHash);
    expect(first.provenance.fingerprint.resolvedTokens).toEqual(["TypeError", "Payment <int> declined"]);
  });

  it("uses the active default owner as a component for hybrid fingerprints", () => {
    const defaultResult = computeGrouping(input(), CONFIG);
    const hybrid = computeGrouping(input({ fingerprint: ["{{ default }}", "{{ type }}"] }), CONFIG);

    expect(hybrid.variant).toBe("custom");
    expect(hybrid.ownerHash).not.toBe(defaultResult.ownerHash);
    expect(hybrid.aliasHashes).toEqual([]);
    expect(hybrid.provenance.fingerprint.type).toBe("hybrid");
    expect(hybrid.provenance.fingerprint.resolvedTokens).toEqual(["TypeError"]);
  });

  it("resolves stack tokens from normalized parsed frames", () => {
    const result = computeGrouping(input({
      fingerprint: [
        "{{ stack }}",
        "{{ stack.function }}",
        "{{ stack.filename }}",
        "{{ stack.abs_path }}",
        "{{ stack.module }}",
      ],
    }), CONFIG);

    expect(result.variant).toBe("custom");
    expect(result.provenance.fingerprint.resolvedTokens[0]).toContain("renderRow");
    expect(result.provenance.fingerprint.resolvedTokens[1]).toBe("renderRow");
    expect(result.provenance.fingerprint.resolvedTokens[2]).toBe("/static/js/table.js");
    expect(result.provenance.fingerprint.resolvedTokens[3]).toBe("https://app.example.com/static/js/table.js");
    expect(result.provenance.fingerprint.resolvedTokens[4]).toBe("static/js/table");
  });

  it("fails visibly for an unsupported variable instead of treating it as default", () => {
    const result = computeGrouping(input({ fingerprint: ["{{ unsupported }}"] }), CONFIG);

    expect(result.variant).toBe("degraded");
    expect(result.ownerHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.provenance.fingerprint.source).toBe("degraded");
  });
});

describe("readGroupingFingerprint", () => {
  it("reads the flat override and ignores the local scalar fingerprint", () => {
    expect(readGroupingFingerprint({
      fingerprint: "local-dedupe-key",
      fingerprint_override: ["{{ type }}"],
    })).toEqual(["{{ type }}"]);
    expect(readGroupingFingerprint({ fingerprint: "local-dedupe-key" })).toBeUndefined();
  });

  it("accepts the rich envelope array and prefers an explicit override", () => {
    expect(readGroupingFingerprint({ fingerprint: ["{{ message }}"] })).toEqual(["{{ message }}"]);
    expect(readGroupingFingerprint({
      fingerprint: ["{{ message }}"],
      fingerprint_override: ["{{ type }}"],
    })).toEqual(["{{ type }}"]);
  });

  it("fails closed for a malformed fingerprint array", () => {
    expect(readGroupingFingerprint({ fingerprint_override: ["{{ type }}", 42] })).toBeUndefined();
  });

  it("ignores fingerprints outside the durable provenance bounds instead of persisting unreadable evidence", () => {
    expect(readGroupingFingerprint({ fingerprint: Array.from({ length: 33 }, (_, index) => `token-${index}`) })).toBeUndefined();
    expect(readGroupingFingerprint({ fingerprint: ["x".repeat(513)] })).toBeUndefined();
    expect(readGroupingFingerprint({ fingerprint: Array.from({ length: 32 }, (_, index) => `token-${index}`) })).toHaveLength(32);
  });

  it("marks an oversized durable fingerprint as degraded provenance", () => {
    const resolved = resolveGroupingFingerprint(["{{ stack }}"], input(), [{
      function: "renderRow",
      filename: "x".repeat(70_000),
      absPath: null,
      module: null,
      lineno: null,
      colno: null,
      inApp: true,
    }]);

    expect(resolved.provenance.source).toBe("degraded");
    expect(resolved.provenance.tokens).toEqual([]);
    expect(resolved.resolvedValues).toEqual([]);
  });
});

describe("classifyGroupingFingerprint", () => {
  it("treats omitted and empty fingerprints as default", () => {
    expect(classifyGroupingFingerprint(undefined)).toBe("default");
    expect(classifyGroupingFingerprint([])).toBe("default");
  });

  it("distinguishes custom and hybrid fingerprints", () => {
    expect(classifyGroupingFingerprint(["literal"])).toBe("custom");
    expect(classifyGroupingFingerprint(["{{ default }}", "literal"])).toBe("hybrid");
    expect(classifyGroupingFingerprint(["{{ default }}"])).toBe("default");
  });
});
