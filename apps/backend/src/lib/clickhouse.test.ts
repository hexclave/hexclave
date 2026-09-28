import { describe, expect, it } from "vitest";
import { EXTERNAL_CLICKHOUSE_SETTINGS } from "./clickhouse";

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
