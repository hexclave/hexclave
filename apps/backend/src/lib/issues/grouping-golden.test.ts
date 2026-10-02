
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ONLY_STACK_FIXTURE,
  BROWSER_STACK_FIXTURES,
  MINIFIED_BUNDLE_STACK_FIXTURE,
  NODE_STACK_FIXTURE,
  SYNTHETIC_OBJECT_THROW_FIXTURE,
} from "./__fixtures__/browser-stacks";
import { DEFAULT_GROUPING_CONFIG_ID } from "./grouping-config";
import { computeGrouping } from "./grouping";
import type { GroupingInput } from "./types";

function golden(input: GroupingInput): { ownerHash: string, aliasHashes: string[], variant: string, culprit: string } {
  const result = computeGrouping(input, DEFAULT_GROUPING_CONFIG_ID);
  return {
    ownerHash: result.ownerHash,
    aliasHashes: result.aliasHashes,
    variant: result.variant,
    culprit: result.culprit,
  };
}

function fixture(name: string): GroupingInput {
  const found = BROWSER_STACK_FIXTURES.get(name);
  if (found === undefined) throw new Error(`Missing stack fixture ${name}`);
  return found;
}

describe("golden vectors — hexclave-js:2026-08-01", () => {
  it("a realistic Chrome stack", () => {
    expect(golden(fixture("chrome-15"))).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "bar (/to/file.js)",
        "ownerHash": "930e5752f2ec6fa1d64268817c4ac9e0",
        "variant": "system",
      }
    `);
  });

  it("a realistic Firefox stack", () => {
    expect(golden(fixture("firefox-31"))).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "foo (/to/file.js)",
        "ownerHash": "0ce0821f59349b6e4568649060a1ecd3",
        "variant": "system",
      }
    `);
  });

  it("a realistic Node stack", () => {
    expect(golden(NODE_STACK_FIXTURE)).toMatchInlineSnapshot(`
      {
        "aliasHashes": [
          "0b1e5f63ec146bc87c2df7cbf45bd3e6",
        ],
        "culprit": "getUser (/srv/app/src/app/api/users/route.ts)",
        "ownerHash": "752af83fd1724563837daa01808b0790",
        "variant": "app",
      }
    `);
  });

  it("a minified single-line bundle", () => {
    expect(golden(MINIFIED_BUNDLE_STACK_FIXTURE)).toMatchInlineSnapshot(`
      {
        "aliasHashes": [
          "cb0d0e7274f304462683c128c10afcfa",
        ],
        "culprit": "o (/_next/static/chunks/4711-9f2c1ad3e4b57c60.js)",
        "ownerHash": "5e0c191dac7979c7195dd2425dcbea0c",
        "variant": "app",
      }
    `);
  });

  it("an anonymous-frame-only stack", () => {
    expect(golden(ANONYMOUS_ONLY_STACK_FIXTURE)).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "<anonymous>",
        "ownerHash": "7154575396ab260aec93d20810aade1a",
        "variant": "system",
      }
    `);
  });

  it("a synthetic object throw", () => {
    expect(golden(SYNTHETIC_OBJECT_THROW_FIXTURE)).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "/_next/static/chunks/main-app-1c0f0d3b9a7e4f21.js",
        "ownerHash": "97c1b9df8d70f48cef46f653d5d3fae7",
        "variant": "message",
      }
    `);
  });

  it("a stack in which no frame contributes anything hashable", () => {
    expect(golden({
      type: "Error",
      message: "boom in job 4711",
      platform: "javascript",
      stack: ["Error: boom in job 4711", "    at <anonymous>:1:1", "    at <anonymous>:2:1"].join("\n"),
    })).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "<anonymous>",
        "ownerHash": "6bbf5a7329ef33d83faf2567f3a4ae41",
        "variant": "message",
      }
    `);
  });

  it("a stackless throw (message variant)", () => {
    expect(golden({ type: "Error", message: "Payment 12345 declined", stack: null, platform: "javascript" })).toMatchInlineSnapshot(`
      {
        "aliasHashes": [],
        "culprit": "<unknown>",
        "ownerHash": "17ce17ee4a98f8f3a89ab2403dd4d7ec",
        "variant": "message",
      }
    `);
  });
});

describe("hash encoding", () => {
  it("is injective across leaf boundaries", () => {
    const first = computeGrouping({ type: "AB", message: "", stack: null, platform: "javascript" }, DEFAULT_GROUPING_CONFIG_ID);
    const second = computeGrouping({ type: "A", message: "B", stack: null, platform: "javascript" }, DEFAULT_GROUPING_CONFIG_ID);
    expect(first.ownerHash).not.toBe(second.ownerHash);
  });

  it("is 128 bits of lowercase hex", () => {
    const result = computeGrouping(fixture("chrome-15"), DEFAULT_GROUPING_CONFIG_ID);
    expect(result.ownerHash).toMatch(/^[0-9a-f]{32}$/);
  });
});
