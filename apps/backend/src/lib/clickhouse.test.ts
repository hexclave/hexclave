import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_CLICKHOUSE_SETTINGS, getClickhouseWriteAvailability, stripLoneSurrogates } from "./clickhouse";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ClickHouse write availability", () => {
  it("is absent when the ClickHouse URL is empty", () => {
    vi.stubEnv("HEXCLAVE_CLICKHOUSE_URL", "");
    vi.stubEnv("STACK_CLICKHOUSE_URL", "");
    expect(getClickhouseWriteAvailability()).toBe("absent");
  });

  it("is configured when the ClickHouse URL is set", () => {
    vi.stubEnv("HEXCLAVE_CLICKHOUSE_URL", "http://localhost:8123");
    vi.stubEnv("STACK_CLICKHOUSE_URL", "http://localhost:8123");
    expect(getClickhouseWriteAvailability()).toBe("configured");
  });
});

describe("external ClickHouse client settings", () => {
  it("bounds memory for every limited-user query", () => {
    expect(EXTERNAL_CLICKHOUSE_SETTINGS).toMatchInlineSnapshot(`
      {
        "join_algorithm": "grace_hash,parallel_hash,hash",
        "max_bytes_before_external_group_by": "256000000",
        "max_memory_usage": "512000000",
        "max_memory_usage_for_user": "9000000000",
      }
    `);
  });
});

describe("ClickHouse string sanitization", () => {
  it("replaces lone surrogates in nested values without changing valid pairs or keys", () => {
    const malformedKey = `key-${"\uD800"}`;

    expect(stripLoneSurrogates({
      [malformedKey]: "\uD800",
      nested: ["plain", "\uD800", "\uDC00", "\uD83D\uDE00", 42, true, null],
    })).toEqual({
      [malformedKey]: "�",
      nested: ["plain", "�", "�", "😀", 42, true, null],
    });
  });
});
