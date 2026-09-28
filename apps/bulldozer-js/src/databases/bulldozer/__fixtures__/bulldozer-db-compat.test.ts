import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declareInMemoryLowLevelDatabase } from "../../low-level/implementations/in-memory.js";
import { declareBasePiledriverDatabase } from "../../piledriver/implementations/base.js";
import { declareBulldozerDatabase, declareGroupByTable, defineMaterializeTable, defineSortTable, defineStoredTable } from "../index.js";
import { BulldozerDbDump, computeReadModel, restoreBulldozerDatabase } from "./bulldozer-db-fixture-utils.js";

// Golden whole-database serialization fixtures. Each file freezes an entire persisted Bulldozer
// database (every derived table, group and row) as written to the low-level backend for a given node
// format version. Loading them with the *current* code proves that a complete database written by an
// older build (already deployed to prod) still deserializes and reads back consistently — not just a
// single tree, but the full derived-table graph. Regenerate/add fixtures with
// `generate-bulldozer-db-fixtures.ts`; never hand-edit existing ones.
const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): BulldozerDbDump {
  // Boundary parse of a checked-in fixture file; every assertion below exercises the shape.
  return JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")) as BulldozerDbDump;
}

// The exact split of the fixture schema (example-schema.ts) into tables whose rows the current code
// can list and tables that reject row listing. Derived by hand from the schema — NOT from the code
// under test — so that a table regressing to (or away from) supporting row listing fails the
// assertions below instead of silently dropping out of the read-model comparison. Unlistable are the
// stateless Sort and count-only GroupBy tables plus every lazy operator (filter/map/flatMap/concat)
// whose full-scan read path goes through one of them; stateful operators (stored, leftFold, leftJoin,
// timeFold, reduce, compact) own their rows and stay listable regardless of their inputs.
const expectedReadableTableIds = [
  "accountCounterpartyJoinedSample",
  "accountEntriesRunningExposure",
  "accountEntriesTimedExposure",
  "accountEntriesTimedReprice",
  "accountSummary",
  "compactedDebits",
  "ledgerEntries",
];
const expectedUnlistableTableIds = [
  "accountAssetPartitions",
  "accountDebits",
  "accountDebitsSorted",
  "accountEntriesNormalized",
  "accountEntriesSortedByAmount",
  "accountEntriesWithCounterparty",
  "accountEntryLegs",
  "accountPriorityEntries",
  "assetEntriesNormalized",
  "entriesByAccount",
  "entriesByAsset",
  "highValueEntriesByAsset",
  "highValueEntriesByAssetAccount",
];

describe("bulldozer whole-database serialization compatibility", () => {
  // v0 = pre-versioning tree nodes; v1 = materialized Sort/GroupBy; v2 = stateless Sort and
  // count-only GroupBy.
  for (const version of ["db-v0", "db-v1", "db-v2"] as const) {
    it(`reads the entire database from golden fixture ${version} with the current code`, async () => {
      const fixture = loadFixture(version);
      const db = await restoreBulldozerDatabase(fixture);
      const { readModel, unlistableTableIds } = await computeReadModel(db);
      expect(readModel.map(table => table.tableId)).toEqual(expectedReadableTableIds);
      expect(unlistableTableIds).toEqual(expectedUnlistableTableIds);
      // Deserializing the whole persisted database and re-reading every table must reproduce exactly
      // the readable logical state its writer observed — including the v0 path where augmentations
      // are recomputed, not trusted. Fixtures written before Sort/GroupBy became non-materialized
      // (v0/v1) still contain read models for the now-unlistable tables; those are exactly the
      // pinned `expectedUnlistableTableIds` and are exempt from the comparison.
      expect(readModel).toEqual(fixture.readModel.filter(table => expectedReadableTableIds.includes(table.tableId)));
    });

    it(`mutates a database loaded from golden fixture ${version} into valid current-format state`, async () => {
      const fixture = loadFixture(version);
      const db = await restoreBulldozerDatabase(fixture);
      await db.withSnapshotConsistent(async snapshot =>
        (await snapshot.setOrDeleteRow({
          tableId: "ledgerEntries",
          rowIdentifier: "entry-900",
          newRowData: { accountId: "acct-alice", asset: "USD", amount: "500", side: "credit", txHash: "0xfff900", blockNumber: 200, timestamp: "2026-01-02T00:00:00.000Z", counterparty: "acct-bob", memo: "post-load write" },
        })).newSnapshot,
      );
      const { snapshot } = await db.getSnapshot();
      const rows = [];
      for await (const row of snapshot.listRowsInGroup({ tableId: "accountEntriesRunningExposure", groupKey: "acct-alice", range: {} })) {
        rows.push(row.rowIdentifier);
      }
      expect(rows).toContain("entry-900");
    });

    it(`removes the final GroupBy rows and their group in golden fixture ${version}`, async () => {
      const db = await restoreBulldozerDatabase(loadFixture(version));
      await db.withSnapshotConsistent(async snapshot => {
        for (const rowIdentifier of ["entry-001", "entry-002", "entry-006"]) {
          snapshot = (await snapshot.setOrDeleteRow({
            tableId: "ledgerEntries",
            rowIdentifier,
            newRowData: undefined,
          })).newSnapshot;
        }
        return snapshot;
      });

      const { snapshot } = await db.getSnapshot();
      const accountGroups = [];
      for await (const group of snapshot.listGroups({ tableId: "entriesByAccount", range: {} })) {
        accountGroups.push(group.groupKey);
      }
      expect(accountGroups).not.toContain("acct-alice");

      const runningExposureRows = [];
      for await (const row of snapshot.listRowsInGroup({ tableId: "accountEntriesRunningExposure", groupKey: "acct-alice", range: {} })) {
        runningExposureRows.push(row);
      }
      expect(runningExposureRows).toEqual([]);
    });
  }
});

describe("computeReadModel", () => {
  it("classifies empty non-listable tables the same as populated ones", async () => {
    // An empty Sort/GroupBy never gets its listRowsInGroup called during a plain group walk (there
    // are no groups), so without the nonexistent-group probe it would be misclassified as listable
    // and the read model would depend on whether the table happens to contain data.
    const db = declareBulldozerDatabase(
      declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(`bulldozer-empty-read-model-${crypto.randomUUID()}`)),
      {
        migrations: [[
          { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
          { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => row.rowIdentifier, sortKeyComparator: (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0 }), inputTables: { input: "store" } },
          { type: "initTable", tableId: "grouped", table: declareGroupByTable({ groupKeyExtractor: async row => row.rowIdentifier, groupKeyComparator: (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0 }), inputTables: { input: "store" } },
          { type: "initTable", tableId: "sortedMaterialized", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
        ]],
      },
    );
    await db.applyRemainingMigrations();

    const { readModel, unlistableTableIds } = await computeReadModel(db);
    expect(unlistableTableIds).toEqual(["grouped", "sorted"]);
    expect(readModel).toEqual([
      { tableId: "sortedMaterialized", groups: [] },
      { tableId: "store", groups: [] },
    ]);
  });
});
