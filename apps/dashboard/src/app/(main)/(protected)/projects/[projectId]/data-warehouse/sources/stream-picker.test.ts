import type { DataSourceCatalogJson, DataSourceCatalogTableJson, DataSourceStreamConfig } from "@hexclave/shared/dist/interface/admin-interface";
import { describe, expect, it } from "vitest";
import { buildInitialSelection } from "./stream-picker";

function table(tableName: string): DataSourceCatalogTableJson {
  return {
    schema_name: "public",
    table_name: tableName,
    approx_rows: 10,
    replica_identity: "d",
    is_partitioned: false,
    primary_key_columns: ["id"],
    cursor_candidates: [{ column: "id", data_type: "bigint", indexed: true }],
    available_modes: [
      { mode: "cdc", available: true, reason: null },
      { mode: "cursor", available: true, reason: null },
    ],
    recommended_mode: "cdc",
    default_cursor_column: "id",
  };
}

const catalog: DataSourceCatalogJson = {
  capabilities: {
    version: "16.4",
    wal_level: "logical",
    has_replication: true,
    in_recovery: false,
    slots_used: 0,
    slots_max: 10,
    probed_at_millis: 0,
  },
  tables: ["users", "audit_log"].map(table),
};

describe("StreamPicker initial selection", () => {
  it("selects recommended tables during initial setup", () => {
    const selection = buildInitialSelection(catalog, undefined);

    expect(selection["public.users"]?.on).toBe(true);
    expect(selection["public.audit_log"]?.on).toBe(true);
  });

  it("selects only configured streams while editing", () => {
    const existing: DataSourceStreamConfig[] = [{
      schema_name: "public",
      table_name: "users",
      mode: "cursor",
      cursor_column: "id",
    }];

    const selection = buildInitialSelection(catalog, existing);

    expect(selection["public.users"]).toEqual({ on: true, mode: "cursor", cursorColumn: "id" });
    expect(selection["public.audit_log"]?.on).toBe(false);
  });

  it("keeps every table off when editing a source with no configured streams", () => {
    const selection = buildInitialSelection(catalog, []);

    expect(Object.values(selection).every(value => value?.on === false)).toBe(true);
  });
});
