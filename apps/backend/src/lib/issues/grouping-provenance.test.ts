import { describe, expect, it } from "vitest";
import { DEFAULT_GROUPING_CONFIG_ID } from "./grouping-config";
import { computeGrouping, getGroupingHashProvenance } from "./grouping";
import {
  MAX_GROUPING_PROVENANCE_ENTRIES,
  fromDurableGroupingProvenance,
  parseDurableGroupingProvenance,
  serializeGroupingProvenance,
  toDurableGroupingProvenance,
} from "./grouping-provenance";
import type { GroupingHashProvenance } from "./types";

const fingerprint = {
  type: "default",
  source: "default",
  tokens: [],
  resolvedTokens: [],
} as const;

describe("durable grouping provenance", () => {
  it("retains the primary and secondary roles produced by grouping", () => {
    const grouping = computeGrouping({
      type: "TypeError",
      message: "row is null",
      stack: [
        "TypeError: row is null",
        "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
        "    at commitLayoutEffects (https://app.example.com/node_modules/react-dom/index.js:23426:1)",
      ].join("\n"),
      platform: "javascript",
    }, DEFAULT_GROUPING_CONFIG_ID);

    const provenance = getGroupingHashProvenance(grouping);
    expect(provenance[0]).toMatchObject({
      hash: grouping.ownerHash,
      role: "primary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: grouping.variant,
    });
    expect(provenance.slice(1)).toEqual(grouping.secondaryProvenance);
    expect(provenance.every((entry) => entry.fingerprint.type === "default")).toBe(true);
  });

  it("serializes a bounded snake-case record shared by issue storage and projections", () => {
    const provenance: GroupingHashProvenance[] = [{
      hash: "a".repeat(32),
      role: "primary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "app",
      fingerprint,
    }, {
      hash: "b".repeat(32),
      role: "secondary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "system",
      fingerprint: {
        ...fingerprint,
        tokens: ["{{ default }}"],
      },
    }];

    expect(JSON.parse(serializeGroupingProvenance(provenance))).toEqual([
      {
        hash: "a".repeat(32),
        role: "primary",
        config_id: DEFAULT_GROUPING_CONFIG_ID,
        variant: "app",
        fingerprint: { type: "default", source: "default", tokens: [], resolved_tokens: [] },
      },
      {
        hash: "b".repeat(32),
        role: "secondary",
        config_id: DEFAULT_GROUPING_CONFIG_ID,
        variant: "system",
        fingerprint: {
          type: "default",
          source: "default",
          tokens: ["{{ default }}"],
          resolved_tokens: [],
        },
      },
    ]);
  });

  it("rejects provenance that exceeds the durable bound", () => {
    const provenance: GroupingHashProvenance[] = Array.from({ length: MAX_GROUPING_PROVENANCE_ENTRIES + 1 }, (_, index) => ({
      hash: index.toString(16).padStart(32, "0"),
      role: index === 0 ? "primary" : "secondary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: index === 0 ? "app" : "system",
      fingerprint,
    }));

    expect(() => toDurableGroupingProvenance(provenance)).toThrow(/16-entry limit/);
  });

  it("round-trips through the durable serialization without loss", () => {
    const provenance: GroupingHashProvenance[] = [{
      hash: "a".repeat(32),
      role: "primary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "app",
      fingerprint: { ...fingerprint, tokens: ["{{ default }}"], resolvedTokens: ["value"] },
    }, {
      hash: "b".repeat(32),
      role: "secondary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "system",
      fingerprint,
    }];

    const roundTripped = fromDurableGroupingProvenance(parseDurableGroupingProvenance(serializeGroupingProvenance(provenance)));
    expect(roundTripped).toEqual(provenance);
  });

  it("fails loudly on values no writer produces", () => {
    expect(() => parseDurableGroupingProvenance("")).toThrow(/issue_grouping_provenance/);
    expect(() => parseDurableGroupingProvenance("[]")).toThrow(/between 1 and/);
    expect(() => parseDurableGroupingProvenance(JSON.stringify([{ hash: "a".repeat(32), role: "owner" }]))).toThrow(/malformed entry/);
    expect(() => parseDurableGroupingProvenance(JSON.stringify([{
      hash: "a".repeat(32),
      role: "primary",
      config_id: DEFAULT_GROUPING_CONFIG_ID,
      variant: "app",
      fingerprint: { type: "default", source: "default", tokens: "nope", resolved_tokens: [] },
    }]))).toThrow(/fingerprint token/);
  });

  it("refuses to narrow entries the caller has not vetted", () => {
    const durable = parseDurableGroupingProvenance(serializeGroupingProvenance([{
      hash: "a".repeat(32),
      role: "primary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "app",
      fingerprint,
    }]));

    expect(() => fromDurableGroupingProvenance([{ ...durable[0], config_id: "hexclave-js:retired" }])).toThrow(/unknown config id/);
    expect(() => fromDurableGroupingProvenance([{ ...durable[0], variant: "surprise" }])).toThrow(/unknown variant/);
    expect(() => fromDurableGroupingProvenance([{
      ...durable[0],
      fingerprint: { ...durable[0].fingerprint, type: "surprise" },
    }])).toThrow(/unknown fingerprint type/);
  });
});
