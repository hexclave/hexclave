/**
 * Cross-version whole-database serialization compatibility harness, used by the
 * `bulldozer-serialization-compat` GitHub Actions workflow. Where the golden fixtures freeze a known
 * shape, this proves that two *different code versions* interoperate on an entire Bulldozer database:
 *
 *   emit  <file>   build the deterministic example database, persist it, and write a self-describing
 *                  whole-database dump (KV contents + the read model the writer observed)
 *   verify <file>  load a dump written by (possibly) another code version and assert it reproduces the
 *                  exact read model (every table, group and row) its writer observed, for every table
 *                  whose rows the reading code can list
 *
 * The workflow runs `emit` under one checkout and `verify` under the other, in both directions:
 *   - new code reads a database written by base code  (backward compat: prod upgrade)
 *   - base code reads a database written by new code   (forward compat: prod rollback)
 *
 * This file (and bulldozer-db-fixture-utils.ts) is copied into the base-branch checkout by the
 * workflow, so it must only rely on the long-stable Bulldozer/piledriver public API plus the
 * checked-in example schema.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { declareInMemoryLowLevelDatabase } from "../../low-level/implementations/in-memory.js";
import { BulldozerDbDump, buildFixtureBulldozerDatabase, computeReadModel, dumpBulldozerDatabase, restoreBulldozerDatabase } from "./bulldozer-db-fixture-utils.js";

async function emit(path: string) {
  const lowLevel = declareInMemoryLowLevelDatabase(`bulldozer-cross-version-${crypto.randomUUID()}`);
  const db = await buildFixtureBulldozerDatabase(lowLevel);
  const dump = await dumpBulldozerDatabase(lowLevel, db);
  writeFileSync(path, `${JSON.stringify(dump, null, 2)}\n`);
  process.stdout.write(`emitted whole-database dump to ${path}\n`);
}

async function verify(path: string) {
  // Boundary parse of a dump written by this or another code version; mismatches surface below.
  const dump = JSON.parse(readFileSync(path, "utf8")) as BulldozerDbDump;
  const { readModel: actual, unlistableTableIds } = await computeReadModel(await restoreBulldozerDatabase(dump));
  // The writer may have observed tables that the reading code cannot list: a dump written while
  // Sort/GroupBy were still materialized contains their row read models, which the current stateless
  // implementations intentionally reject. Exempt exactly the tables the reader *explicitly rejected*
  // (rather than whatever happens to be missing from the result), so a table that disappears for any
  // other reason still fails the comparison.
  const expected = dump.readModel.filter(table => !unlistableTableIds.includes(table.tableId));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.stderr.write(`bulldozer whole-database cross-version MISMATCH reading ${path}\n`);
    process.exit(1);
  }
  const skippedSuffix = unlistableTableIds.length === 0 ? "" : `; skipped unlistable tables: ${unlistableTableIds.join(", ")}`;
  process.stdout.write(`verified whole-database dump ${path} (read model reproduced exactly${skippedSuffix})\n`);
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if ((mode !== "emit" && mode !== "verify") || !path) {
    process.stderr.write("usage: bulldozer-db-cross-version.ts <emit|verify> <file>\n");
    process.exit(2);
    return;
  }
  if (mode === "emit") await emit(path);
  else await verify(path);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
