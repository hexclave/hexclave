import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUPING_CONFIG_ID,
  GROUPING_CONFIGS,
  GROUPING_CONFIG_IDS,
  isGroupingConfigId,
  resolveActiveGroupingConfigId,
  resolveGroupingConfig,
} from "./grouping-config";

describe("grouping config registry", () => {
  it("lists exactly the configs it can describe", () => {
    expect([...GROUPING_CONFIGS.keys()]).toEqual([...GROUPING_CONFIG_IDS]);
  });

  it("has a config whose `id` matches its key", () => {
    for (const [key, config] of GROUPING_CONFIGS) {
      expect(config.id).toBe(key);
    }
  });

  it("defaults to a config that exists", () => {
    expect(GROUPING_CONFIGS.has(DEFAULT_GROUPING_CONFIG_ID)).toBe(true);
  });

  it("snapshots the registry, so retiring a config is never silent", () => {
    expect([...GROUPING_CONFIG_IDS]).toMatchInlineSnapshot(`
      [
        "hexclave-js:2026-08-01",
        "hexclave-js:2026-08-20",
      ]
    `);
  });
});

describe("isGroupingConfigId", () => {
  it.each([
    ["a known id", "hexclave-js:2026-08-01", true],
    ["a retired-looking id", "hexclave-js:1999-01-01", false],
    ["the empty string", "", false],
    ["a number", 42, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["an object", { id: "hexclave-js:2026-08-01" }, false],
  ])("%s", (_name, value, expected) => {
    expect(isGroupingConfigId(value)).toBe(expected);
  });

  it("narrows to the union", () => {
    const fromDatabase: unknown = "hexclave-js:2026-08-01";
    if (!isGroupingConfigId(fromDatabase)) throw new Error("expected the id to narrow");
    expect(GROUPING_CONFIGS.get(fromDatabase)?.introducedAt).toMatchInlineSnapshot(`"2026-08-01"`);
  });
});

describe("resolveActiveGroupingConfigId", () => {
  it("uses the current default when older projects have no rollout setting", () => {
    expect(resolveActiveGroupingConfigId(undefined)).toBe(DEFAULT_GROUPING_CONFIG_ID);
  });

  it("accepts a configured registry id", () => {
    expect(resolveActiveGroupingConfigId({ activeConfigId: DEFAULT_GROUPING_CONFIG_ID })).toBe(DEFAULT_GROUPING_CONFIG_ID);
  });

  it("fails closed for a stale or unsupported id", () => {
    expect(() => resolveActiveGroupingConfigId({ activeConfigId: "hexclave-js:retired" })).toThrow("Unknown active grouping config id");
  });
});

describe("resolveGroupingConfig", () => {
  it("defaults to the rendered-config id and keeps the newer algorithm readable", () => {
    expect(DEFAULT_GROUPING_CONFIG_ID).toBe("hexclave-js:2026-08-01");
    expect(resolveGroupingConfig(undefined)).toEqual({
      activeConfigId: "hexclave-js:2026-08-01",
      readableConfigIds: ["hexclave-js:2026-08-20"],
      provenance: { active: "default", readable: "default" },
    });
  });

  it("resolves readable ids from enabled settings without duplicating the active id", () => {
    expect(resolveGroupingConfig({
      activeConfigId: DEFAULT_GROUPING_CONFIG_ID,
      readableConfigIds: {
        [DEFAULT_GROUPING_CONFIG_ID]: { enabled: true },
      },
    })).toEqual({
      activeConfigId: DEFAULT_GROUPING_CONFIG_ID,
      readableConfigIds: [],
      provenance: { active: "configured", readable: "configured" },
    });
  });

  it("ignores retired ids in the readable chain", () => {
    expect(resolveGroupingConfig({
      readableConfigIds: { "hexclave-js:retired": { enabled: true } },
    }).readableConfigIds).toEqual([]);
  });
});
