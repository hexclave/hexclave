/**
 * Regenerates the golden whole-database serialization fixtures used by `bulldozer-db-compat.test.ts`.
 *
 * Each fixture freezes an entire persisted Bulldozer database (the example ledger schema, exercising
 * every table operator) as it is written to disk for a given node format version, so that if a future
 * change alters how the database is (de)serialized in a way that breaks reading previously-persisted
 * production data, the compat test fails immediately.
 *
 * Every new fixture is produced from a real LMDB-backed run (its values are exactly the bytes an LMDB
 * `data.mdb` stores). Existing fixtures are immutable: `v0` captures pre-versioning tree nodes, `v1`
 * captures materialized Sort/GroupBy tables, and `v2` captures stateless Sort and count-only GroupBy.
 *
 * IMPORTANT: never edit or delete an existing fixture by hand. When persisted Bulldozer output
 * changes, update the new fixture name below and run:
 *
 *   pnpm -C apps/bulldozer-js exec tsx src/databases/bulldozer/__fixtures__/generate-bulldozer-db-fixtures.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { declareLmdbLowLevelDatabase } from "../../low-level/implementations/lmdb.js";
import { BulldozerDbDump, buildFixtureBulldozerDatabase, dumpBulldozerDatabase } from "./bulldozer-db-fixture-utils.js";

const here = dirname(fileURLToPath(import.meta.url));

function writeFixture(name: string, body: BulldozerDbDump) {
  const path = join(here, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  process.stdout.write(`wrote ${path}\n`);
}

async function main() {
  const lmdbPath = mkdtempSync(join(tmpdir(), "bulldozer-db-fixture-"));
  try {
    const lowLevel = declareLmdbLowLevelDatabase({ path: lmdbPath, dbId: "bulldozer" });
    const db = await buildFixtureBulldozerDatabase(lowLevel);
    writeFixture("db-v2", await dumpBulldozerDatabase(lowLevel, db));
  } finally {
    rmSync(lmdbPath, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
