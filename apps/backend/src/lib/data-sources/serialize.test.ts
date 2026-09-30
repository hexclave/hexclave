import { describe, expect, it } from "vitest";
import type { DataSourceProbeResult } from "./probe";
import { serializeCatalog } from "./serialize";

describe("data source serialization", () => {
  it("preserves an unknown replication slot maximum as null across JSON", () => {
    const probe: DataSourceProbeResult = {
      capabilities: {
        version: "16.4",
        walLevel: "logical",
        hasReplication: true,
        inRecovery: false,
        slotsUsed: 0,
        slotsMax: null,
        probedAtMillis: 0,
      },
      tables: [],
    };

    const serialized = serializeCatalog(probe);

    expect(serialized.capabilities.slots_max).toBeNull();
    expect(JSON.stringify(serialized)).toContain('"slots_max":null');
  });
});
