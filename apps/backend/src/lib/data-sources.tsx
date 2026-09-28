import { createClickhouseWarehouseClient } from "@/lib/clickhouse";
import { ensureDataWarehouseEntitlement, getDataWarehouse, getDataWarehouseNames, getDataWarehouseQueryAuth } from "@/lib/data-warehouse";
import { getDestinationTableName } from "@/lib/data-sources/clickhouse-destination";
import { DATA_SOURCE_SSL_MODES, quotePgIdentifier, withDataSourceClient, type DataSourceCredentials } from "@/lib/data-sources/postgres";
import { probeDataSource, type DataSourceProbeResult, type ProbedTable } from "@/lib/data-sources/probe";
import { runStreamSyncs, type StreamSyncPlan, type SyncCursorState } from "@/lib/data-sources/sync";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import type { DataSource, DataSourceStream } from "@/generated/prisma/client";
import {
  getDefaultCursorColumn,
  getModeAvailability,
  type DataSourceSyncMode,
} from "@hexclave/shared/dist/data-sources/modes";
import { decryptWithKms, encryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { yupObject, yupString, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";

const encryptedPasswordSchema = yupObject({
  edkBase64: yupString().defined(),
  ciphertextBase64: yupString().defined(),
}).defined();

/** How long a claimed sync may run before the scheduler assumes it died. */
const SYNC_CLAIM_LEASE_SECONDS = 900;

const MODE_TO_PRISMA = {
  cursor: "CURSOR",
  cdc: "CDC",
} as const;
const MODE_FROM_PRISMA = {
  CURSOR: "cursor",
  CDC: "cdc",
} as const;

export type DataSourceWithStreams = DataSource & { streams: DataSourceStream[] };

async function decryptPassword(encrypted: DataSource["encryptedPassword"]): Promise<string> {
  const envelope = await yupValidate(encryptedPasswordSchema, encrypted);
  return await decryptWithKms(envelope);
}

export async function getCredentials(source: DataSource): Promise<DataSourceCredentials> {
  return {
    host: source.host,
    port: source.port,
    database: source.database,
    username: source.username,
    password: await decryptPassword(source.encryptedPassword),
    sslMode: source.sslMode,
  };
}

/**
 * Sources write into the project's own warehouse database, so there has to be
 * one. Failing here rather than at sync time keeps the customer from configuring
 * streams that could never have run.
 */
async function getWarehouseDatabaseName(tenancy: Tenancy): Promise<string> {
  const warehouse = await getDataWarehouse(tenancy);
  if (warehouse == null || warehouse.status !== "READY") {
    throw new StatusError(
      StatusError.BadRequest,
      "This project does not have a data warehouse yet. Provision one before connecting a source.",
    );
  }
  return warehouse.databaseName || getDataWarehouseNames(tenancy.project.id).databaseName;
}

export async function listDataSources(tenancy: Tenancy): Promise<DataSourceWithStreams[]> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.dataSource.findMany({
    where: { tenancyId: tenancy.id, status: { not: "DELETING" } },
    include: { streams: { orderBy: [{ schemaName: "asc" }, { tableName: "asc" }] } },
    orderBy: { createdAt: "asc" },
  });
}

/** Null for a missing source and for one being deleted, which is gone as far as every caller can tell. */
async function findDataSource(tenancy: Tenancy, dataSourceId: string): Promise<DataSourceWithStreams | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.dataSource.findFirst({
    where: { id: dataSourceId, tenancyId: tenancy.id, status: { not: "DELETING" } },
    include: { streams: { orderBy: [{ schemaName: "asc" }, { tableName: "asc" }] } },
  });
}

export async function getDataSourceOrThrow(tenancy: Tenancy, dataSourceId: string): Promise<DataSourceWithStreams> {
  const source = await findDataSource(tenancy, dataSourceId);
  if (source == null) throw new StatusError(StatusError.NotFound, "No such data source.");
  return source;
}

export type CreateDataSourceInput = {
  host: string,
  port: number,
  database: string,
  username: string,
  password: string,
  sslMode: string,
};

function assertValidSslMode(sslMode: string): void {
  if (!(DATA_SOURCE_SSL_MODES as readonly string[]).includes(sslMode)) {
    throw new StatusError(StatusError.BadRequest, `Unsupported SSL mode: ${sslMode}`);
  }
}

/**
 * Probes first, and only stores the source if the probe succeeded. A source row
 * that has never once connected is worse than no row: it shows up in the list
 * looking configured.
 */
export async function createDataSource(
  tenancy: Tenancy,
  input: CreateDataSourceInput,
): Promise<{ source: DataSourceWithStreams, probe: DataSourceProbeResult }> {
  await ensureDataWarehouseEntitlement(tenancy);
  await getWarehouseDatabaseName(tenancy);
  assertValidSslMode(input.sslMode);

  const probe = await probeDataSource({ ...input, sslMode: input.sslMode });
  const encryptedPassword = await encryptWithKms(input.password);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const source = await prisma.dataSource.create({
    data: {
      tenancyId: tenancy.id,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      sslMode: input.sslMode,
      encryptedPassword,
      capabilities: probe.capabilities,
      status: "PENDING",
    },
    include: { streams: true },
  });
  return { source, probe };
}

/**
 * A logical slot that nobody consumes retains WAL on the source database. Keep
 * teardown in one idempotent path so configuration changes and source deletion
 * cannot accidentally disagree about which objects Hexclave owns.
 */
async function dropCdcInfrastructure(source: DataSource): Promise<void> {
  const credentials = await getCredentials(source);
  const slotName = getReplicationSlotName(source.id);
  await withDataSourceClient(credentials, async client => {
    await client.query(
      `SELECT pg_drop_replication_slot($1) WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)`,
      [slotName],
    );
    await client.query(`DROP PUBLICATION IF EXISTS ${quotePgIdentifier(slotName)}`);
  }, { allowWrites: true });
}

/**
 * Deletes immediately when no sync holds the lease. Otherwise the source is only
 * marked DELETING — which already hides it from every read — and the scheduler
 * finishes the job once the running sync releases the lease. Waiting for the
 * lease is what keeps cleanup from racing a sync: dropping a slot the sync is
 * reading fails, and a sync past its read-the-row step would recreate a slot
 * dropped underneath it.
 */
export async function deleteDataSource(tenancy: Tenancy, dataSourceId: string): Promise<void> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const claimStartedAt = new Date();
  // Marks and claims in one statement. Deleting an already-DELETING source is
  // allowed so a repeated click retries the cleanup rather than 404ing.
  const marked = await prisma.$queryRaw<{ claimed: boolean }[]>`
    UPDATE "DataSource"
    SET
      "status" = 'DELETING',
      "updatedAt" = NOW(),
      "lastSyncStartedAt" = CASE
        WHEN "lastSyncStartedAt" IS NULL
          OR "lastSyncStartedAt" <= "lastSyncFinishedAt"
          OR "lastSyncStartedAt" < NOW() - make_interval(secs => ${SYNC_CLAIM_LEASE_SECONDS})
        THEN ${claimStartedAt}
        ELSE "lastSyncStartedAt"
      END
    WHERE "id" = ${dataSourceId}::uuid AND "tenancyId" = ${tenancy.id}::uuid
    RETURNING ("lastSyncStartedAt" = ${claimStartedAt}) AS "claimed"
  `;
  if (marked.length === 0) throw new StatusError(StatusError.NotFound, "No such data source.");
  if (!marked[0].claimed) return;
  await removeDeletingDataSource(tenancy, dataSourceId);
}

/** Caller must hold the sync lease on a DELETING source. */
async function removeDeletingDataSource(tenancy: Tenancy, dataSourceId: string): Promise<void> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const source = await prisma.dataSource.findFirst({ where: { id: dataSourceId, tenancyId: tenancy.id, status: "DELETING" } });
  if (source == null) return;

  // Drop the replication slot before forgetting it exists: a slot nobody reads
  // retains write-ahead log on the customer's server until their disk fills.
  //
  // Attempted unconditionally rather than only when replicationSlotName is set,
  // because that column is written after a sync completes — a sync that created
  // the slot and then timed out leaves one behind with no record of it. The name
  // is derived from the source id, so it is always recoverable.
  try {
    await dropCdcInfrastructure(source);
  } catch (error) {
    // The source may be unreachable, which must not make it undeletable. The slot
    // is then the customer's to drop, and this records why we could not.
    captureError("data-source-slot-cleanup", error);
  }

  // Destination tables are deliberately left in place: they are the customer's
  // data, in the customer's warehouse, and dropping them on a disconnect would
  // be a surprising amount of destruction for one click.
  await prisma.dataSource.deleteMany({ where: { id: source.id, status: "DELETING" } });
}

/** Deterministic so cleanup never depends on having recorded the name. */
export function getReplicationSlotName(dataSourceId: string): string {
  return `hexclave_${dataSourceId.replace(/-/g, "")}`;
}

/** Re-reads capabilities and catalog, and persists the capability snapshot. */
export async function refreshDataSourceProbe(tenancy: Tenancy, dataSourceId: string): Promise<DataSourceProbeResult> {
  // Gated like the other outbound paths: this opens a connection to the
  // customer's database, so a project that has lost the entitlement must not
  // keep being able to trigger it.
  await ensureDataWarehouseEntitlement(tenancy);
  const source = await getDataSourceOrThrow(tenancy, dataSourceId);
  const credentials = await getCredentials(source);
  const probe = await probeDataSource(credentials);
  const prisma = await getPrismaClientForTenancy(tenancy);
  await prisma.dataSource.update({
    where: { id: source.id },
    data: { capabilities: probe.capabilities },
  });
  return probe;
}

export type StreamConfigInput = {
  schemaName: string,
  tableName: string,
  mode: DataSourceSyncMode,
  cursorColumn: string | null,
};

/**
 * Whether saving `next` over `existing` invalidates what has been synced so far.
 * A new mode cannot interpret the old one's cursor, a new cursor column makes the
 * old watermark meaningless, and a new primary key changes the destination's
 * ORDER BY — which ReplacingMergeTree deduplicates on, and which CREATE TABLE IF
 * NOT EXISTS would otherwise leave at the old key forever.
 */
export function streamNeedsRebuild(
  existing: Pick<DataSourceStream, "mode" | "cursorColumn" | "primaryKeyColumns">,
  next: { mode: DataSourceSyncMode, cursorColumn: string | null, primaryKeyColumns: readonly string[] },
): boolean {
  return MODE_FROM_PRISMA[existing.mode] !== next.mode
    || existing.cursorColumn !== next.cursorColumn
    || existing.primaryKeyColumns.length !== next.primaryKeyColumns.length
    || existing.primaryKeyColumns.some((column, index) => column !== next.primaryKeyColumns[index]);
}

/**
 * Replaces the stream configuration wholesale. Modes are re-validated against a
 * fresh probe rather than trusted from the client: the dashboard's view of what
 * is available can be minutes old, and CDC on a table that lost its primary key
 * would silently produce an append-only mess.
 */
export async function setDataSourceStreams(
  tenancy: Tenancy,
  dataSourceId: string,
  configs: StreamConfigInput[],
): Promise<DataSourceWithStreams> {
  await ensureDataWarehouseEntitlement(tenancy);
  const source = await getDataSourceOrThrow(tenancy, dataSourceId);
  const credentials = await getCredentials(source);
  const probe = await probeDataSource(credentials);
  const prisma = await getPrismaClientForTenancy(tenancy);

  const tablesByName = new Map(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t]));

  for (const config of configs) {
    const key = `${config.schemaName}.${config.tableName}`;
    const table = tablesByName.get(key);
    if (table == null) {
      throw new StatusError(StatusError.BadRequest, `The source has no readable table ${key}.`);
    }
    const availability = getModeAvailability(table, probe.capabilities)[config.mode];
    if (!availability.available) {
      throw new StatusError(StatusError.BadRequest, `${config.mode} is not available for ${key}: ${availability.reason}.`);
    }
    if (config.mode === "cursor") {
      const cursorColumn = config.cursorColumn ?? getDefaultCursorColumn(table);
      if (cursorColumn == null || !table.cursorCandidates.some(c => c.column === cursorColumn)) {
        throw new StatusError(StatusError.BadRequest, `${cursorColumn ?? "No column"} cannot be used as a cursor for ${key}.`);
      }
    }
  }

  // Every stream change takes the sync lease. Otherwise a worker using the old
  // configuration can finish after this write and overwrite its PENDING
  // rebuild marker, old cursor, or even a newly selected mode. If the worker's
  // lease has expired, this claim also changes its fence token so its completion
  // write is skipped instead of publishing stale stream state.
  const configurationClaimStartedAt = new Date();
  const claimed = await prisma.$executeRaw`
    UPDATE "DataSource"
    SET "lastSyncStartedAt" = ${configurationClaimStartedAt}
    WHERE "id" = ${source.id}::uuid
      AND "status" <> 'DELETING'
      AND (
        "lastSyncStartedAt" IS NULL
        OR "lastSyncStartedAt" <= "lastSyncFinishedAt"
        OR "lastSyncStartedAt" < NOW() - make_interval(secs => ${SYNC_CLAIM_LEASE_SECONDS})
      )
  `;
  if (claimed === 0) {
    // 404 if it was deleted since the read above, otherwise a sync holds the lease.
    await getDataSourceOrThrow(tenancy, dataSourceId);
    throw new StatusError(StatusError.Conflict, "Wait for the running sync to finish before changing the stream configuration.");
  }

  try {
    // Re-read under the lease: the streams read before the claim can be stale if
    // another configuration change finished in between.
    const current = await getDataSourceOrThrow(tenancy, dataSourceId);
    const existingByName = new Map(current.streams.map(s => [`${s.schemaName}.${s.tableName}`, s]));
    const removesLastCdcStream = current.streams.some(stream => stream.mode === "CDC")
      && !configs.some(config => config.mode === "cdc");

    if (removesLastCdcStream) {
      // Unlike source deletion, a configuration update must fail loudly here.
      // Otherwise it can succeed while leaving an unconsumed, WAL-retaining slot.
      await dropCdcInfrastructure(current);
    }

    const keep = new Set(configs.map(c => `${c.schemaName}.${c.tableName}`));
    const removedIds = current.streams
      .filter(stream => !keep.has(`${stream.schemaName}.${stream.tableName}`))
      .map(stream => stream.id);
    const updates: { id: string, mode: string, cursorColumn: string | null, primaryKeyColumns: string, rebuild: boolean }[] = [];
    const inserts: { schemaName: string, tableName: string, mode: string, cursorColumn: string | null, primaryKeyColumns: string, destinationTable: string }[] = [];
    for (const config of configs) {
      const key = `${config.schemaName}.${config.tableName}`;
      const table = tablesByName.get(key)!;
      const existing = existingByName.get(key);
      const cursorColumn = config.mode === "cursor"
        ? (config.cursorColumn ?? getDefaultCursorColumn(table))
        : null;
      const next = {
        mode: MODE_TO_PRISMA[config.mode],
        cursorColumn,
        // JSON rather than a Postgres array parameter: each stream has its own
        // key length, and unnest() cannot take a ragged two-dimensional array.
        primaryKeyColumns: JSON.stringify(table.primaryKeyColumns),
      };
      if (existing == null) {
        inserts.push({
          ...next,
          schemaName: config.schemaName,
          tableName: config.tableName,
          destinationTable: getDestinationTableName(current.id, config.schemaName, config.tableName),
        });
      } else {
        updates.push({ ...next, id: existing.id, rebuild: streamNeedsRebuild(existing, { mode: config.mode, cursorColumn, primaryKeyColumns: table.primaryKeyColumns }) });
      }
    }

    // One statement, so it is atomic without a transaction. Every write is gated
    // on the source row still being ours (lease token unchanged, not DELETING).
    const written = await prisma.$queryRaw<{ id: string }[]>`
      WITH claim AS (
        UPDATE "DataSource"
        SET
          "status" = ${configs.length > 0 ? "ACTIVE" : "PENDING"}::"DataSourceStatus",
          "capabilities" = ${JSON.stringify(probe.capabilities)}::jsonb,
          "replicationSlotName" = CASE WHEN ${removesLastCdcStream} THEN NULL ELSE "replicationSlotName" END,
          "publicationName" = CASE WHEN ${removesLastCdcStream} THEN NULL ELSE "publicationName" END,
          "updatedAt" = NOW()
        WHERE "id" = ${current.id}::uuid
          AND "lastSyncStartedAt" = ${configurationClaimStartedAt}
          AND "status" <> 'DELETING'
        RETURNING "id"
      ),
      removed AS (
        DELETE FROM "DataSourceStream"
        WHERE "dataSourceId" = ${current.id}::uuid
          AND "id" = ANY(${removedIds}::uuid[])
          AND EXISTS (SELECT 1 FROM claim)
      ),
      updated AS (
        UPDATE "DataSourceStream" AS s
        SET
          "mode" = v."mode"::"DataSourceStreamMode",
          "cursorColumn" = v."cursorColumn",
          "primaryKeyColumns" = ARRAY(SELECT jsonb_array_elements_text(v."primaryKeyColumns")),
          -- A rebuild clears the resume point and sends the stream back to
          -- PENDING, which drops and recreates the destination on the next sync.
          "syncCursor" = CASE WHEN v."rebuild" THEN NULL ELSE s."syncCursor" END,
          "status" = CASE WHEN v."rebuild" THEN 'PENDING'::"DataSourceStreamStatus" ELSE s."status" END,
          "error" = CASE WHEN v."rebuild" THEN NULL ELSE s."error" END,
          "rowsSynced" = CASE WHEN v."rebuild" THEN 0 ELSE s."rowsSynced" END,
          "updatedAt" = NOW()
        FROM unnest(
          ${updates.map(u => u.id)}::uuid[],
          ${updates.map(u => u.mode)}::text[],
          ${updates.map(u => u.cursorColumn)}::text[],
          ${updates.map(u => u.primaryKeyColumns)}::jsonb[],
          ${updates.map(u => u.rebuild)}::boolean[]
        ) AS v("id", "mode", "cursorColumn", "primaryKeyColumns", "rebuild")
        WHERE s."id" = v."id"
          AND s."dataSourceId" = ${current.id}::uuid
          AND EXISTS (SELECT 1 FROM claim)
      ),
      inserted AS (
        INSERT INTO "DataSourceStream" (
          "id", "dataSourceId", "createdAt", "updatedAt", "schemaName", "tableName",
          "mode", "cursorColumn", "primaryKeyColumns", "destinationTable", "status", "rowsSynced"
        )
        SELECT
          gen_random_uuid(), ${current.id}::uuid, NOW(), NOW(), v."schemaName", v."tableName",
          v."mode"::"DataSourceStreamMode", v."cursorColumn",
          ARRAY(SELECT jsonb_array_elements_text(v."primaryKeyColumns")),
          v."destinationTable", 'PENDING', 0
        FROM unnest(
          ${inserts.map(i => i.schemaName)}::text[],
          ${inserts.map(i => i.tableName)}::text[],
          ${inserts.map(i => i.mode)}::text[],
          ${inserts.map(i => i.cursorColumn)}::text[],
          ${inserts.map(i => i.primaryKeyColumns)}::jsonb[],
          ${inserts.map(i => i.destinationTable)}::text[]
        ) AS v("schemaName", "tableName", "mode", "cursorColumn", "primaryKeyColumns", "destinationTable")
        WHERE EXISTS (SELECT 1 FROM claim)
      )
      SELECT "id" FROM claim
    `;
    if (written.length === 0) {
      // 404 if the source was deleted while we held the lease; otherwise the
      // lease expired and a newer claim is authoritative.
      await getDataSourceOrThrow(tenancy, dataSourceId);
      throw new StatusError(StatusError.Conflict, "The stream configuration changed while saving. Try again.");
    }
  } finally {
    // Never restore the previous start token: a worker whose old lease expired
    // could otherwise finish later and regain permission to overwrite state.
    // Referencing the current finish column also avoids regressing this marker if
    // a sync completed while the fresh capability probe above was still running.
    await prisma.$executeRaw`
      UPDATE "DataSource"
      SET "lastSyncStartedAt" = "lastSyncFinishedAt"
      WHERE "id" = ${source.id}::uuid
        AND "lastSyncStartedAt" = ${configurationClaimStartedAt}
    `;
  }

  return await getDataSourceOrThrow(tenancy, dataSourceId);
}

async function syncClaimedDataSource(
  tenancy: Tenancy,
  source: DataSourceWithStreams,
  startedAt: Date,
): Promise<DataSourceWithStreams | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  if (source.streams.length === 0) {
    await prisma.dataSource.updateMany({
      where: { id: source.id, lastSyncStartedAt: startedAt },
      data: { lastSyncFinishedAt: new Date() },
    });
    return await findDataSource(tenancy, source.id);
  }

  const databaseName = await getWarehouseDatabaseName(tenancy);
  const credentials = await getCredentials(source);

  let probe: DataSourceProbeResult;
  try {
    probe = await probeDataSource(credentials);
  } catch (error) {
    // A failure to connect is about the source, not any one stream.
    // Recorded, but the source stays ACTIVE: the scheduler only picks up ACTIVE
    // rows, so parking it on FAILED would make one DNS blip stop syncing forever.
    const message = error instanceof Error ? error.message : String(error);
    await prisma.dataSource.updateMany({
      where: { id: source.id, lastSyncStartedAt: startedAt },
      data: { error: message, lastSyncFinishedAt: new Date() },
    });
    return await findDataSource(tenancy, source.id);
  }

  const tablesByName = new Map<string, ProbedTable>(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t]));
  const plans: StreamSyncPlan[] = source.streams.map(stream => ({
    streamId: stream.id,
    schemaName: stream.schemaName,
    tableName: stream.tableName,
    mode: MODE_FROM_PRISMA[stream.mode],
    cursorColumn: stream.cursorColumn,
    primaryKeyColumns: stream.primaryKeyColumns,
    destinationTable: stream.destinationTable,
    syncCursor: stream.syncCursor as SyncCursorState | null,
    isPending: stream.status === "PENDING",
  }));

  const slotName = getReplicationSlotName(source.id);
  // Connects as the project's own warehouse user rather than the ClickHouse
  // admin, so the tenancy boundary is enforced by ClickHouse privileges and the
  // per-project quota — not by the correctness of an interpolated database name.
  const warehouseAuth = await getDataWarehouseQueryAuth(tenancy);
  if (warehouseAuth == null) {
    throw new StatusError(StatusError.BadRequest, "This project's data warehouse is not ready.");
  }
  const clickhouse = createClickhouseWarehouseClient(warehouseAuth, databaseName);
  let results;
  try {
    results = await runStreamSyncs({
      credentials,
      clickhouse,
      databaseName,
      tablesByName,
      slotName,
      publicationName: slotName,
      startedAt,
    }, plans);
  } finally {
    await clickhouse.close();
  }

  const usesCdc = plans.some(plan => plan.mode === "cdc");
  const failed = results.filter(result => result.error != null);
  // Surfaced at the source level only when nothing succeeded; a single bad table
  // is already reported on its own stream.
  const sourceError = failed.length === results.length ? failed[0]?.error ?? null : null;
  // One statement, so it is atomic without a transaction. The stream updates are
  // gated on the source update, which is fenced on this sync's lease token: if a
  // newer claim took over, or the source was deleted, none of this stale state
  // is published.
  const [outcome] = await prisma.$queryRaw<{ completed: boolean, deleting: boolean }[]>`
    WITH claim AS (
      UPDATE "DataSource"
      SET
        "lastSyncFinishedAt" = ${new Date()},
        "status" = 'ACTIVE',
        "error" = ${sourceError},
        "replicationSlotName" = CASE WHEN ${usesCdc} THEN ${slotName} ELSE "replicationSlotName" END,
        "publicationName" = CASE WHEN ${usesCdc} THEN ${slotName} ELSE "publicationName" END,
        "updatedAt" = NOW()
      WHERE "id" = ${source.id}::uuid
        AND "lastSyncStartedAt" = ${startedAt}
        AND "status" <> 'DELETING'
      RETURNING "id"
    ),
    -- Deleted while this sync ran: only release the lease, so the scheduler can
    -- finish the deletion now that nothing is using the slot.
    released AS (
      UPDATE "DataSource"
      SET "lastSyncFinishedAt" = ${new Date()}
      WHERE "id" = ${source.id}::uuid
        AND "lastSyncStartedAt" = ${startedAt}
        AND "status" = 'DELETING'
      RETURNING "id"
    ),
    streams AS (
      UPDATE "DataSourceStream" AS s
      SET
        "status" = v."status"::"DataSourceStreamStatus",
        "error" = v."error",
        -- A truncated source table cannot be represented incrementally, so the
        -- stream goes back to PENDING and the next sync rebuilds it from scratch.
        "syncCursor" = CASE
          WHEN v."clearCursor" THEN NULL
          WHEN v."syncCursor" IS NULL THEN s."syncCursor"
          ELSE v."syncCursor"
        END,
        "rowsSynced" = s."rowsSynced" + v."rowsSynced",
        "lastSyncedAt" = CASE WHEN v."error" IS NULL THEN NOW() ELSE s."lastSyncedAt" END,
        "updatedAt" = NOW()
      FROM unnest(
        ${results.map(r => r.streamId)}::uuid[],
        ${results.map(r => r.error != null ? "FAILED" : r.needsResnapshot === true ? "PENDING" : "ACTIVE")}::text[],
        ${results.map(r => r.error)}::text[],
        ${results.map(r => r.needsResnapshot === true)}::boolean[],
        ${results.map(r => r.syncCursor == null ? null : JSON.stringify(r.syncCursor))}::jsonb[],
        ${results.map(r => r.rowsSynced)}::bigint[]
      ) AS v("id", "status", "error", "clearCursor", "syncCursor", "rowsSynced")
      WHERE s."id" = v."id"
        AND s."dataSourceId" = ${source.id}::uuid
        AND EXISTS (SELECT 1 FROM claim)
    )
    SELECT EXISTS (SELECT 1 FROM claim) AS "completed", EXISTS (SELECT 1 FROM released) AS "deleting"
  `;
  if (outcome.deleting) return null;
  if (!outcome.completed) {
    // A newer lease is now authoritative, so this worker must not publish any of
    // its stale state — and none of it was.
    throw new StatusError(StatusError.Conflict, "This sync's lease expired before it could finish.");
  }

  return await findDataSource(tenancy, source.id);
}

export async function syncDataSource(tenancy: Tenancy, dataSourceId: string): Promise<DataSourceWithStreams> {
  await ensureDataWarehouseEntitlement(tenancy);
  const source = await getDataSourceOrThrow(tenancy, dataSourceId);
  if (source.streams.length === 0) return source;

  const prisma = await getPrismaClientForTenancy(tenancy);
  const startedAt = new Date();
  const claimed = await prisma.$executeRaw`
    UPDATE "DataSource"
    SET "lastSyncStartedAt" = ${startedAt}, "error" = NULL
    WHERE "id" = ${source.id}::uuid
      AND "status" <> 'DELETING'
      AND (
        "lastSyncStartedAt" IS NULL
        OR "lastSyncStartedAt" <= "lastSyncFinishedAt"
        OR "lastSyncStartedAt" < NOW() - make_interval(secs => ${SYNC_CLAIM_LEASE_SECONDS})
      )
  `;
  if (claimed === 0) {
    // 404 if it was deleted since the read above, otherwise a sync holds the lease.
    await getDataSourceOrThrow(tenancy, dataSourceId);
    throw new StatusError(StatusError.Conflict, "A sync is already running for this source.");
  }

  try {
    // Configuration may have changed between the initial read and our claim.
    // Once the lease is ours, re-read so execution cannot resurrect a removed CDC
    // stream (and its replication slot) from a stale plan.
    const claimedSource = await getDataSourceOrThrow(tenancy, dataSourceId);
    const synced = await syncClaimedDataSource(tenancy, claimedSource, startedAt);
    if (synced == null) throw new StatusError(StatusError.NotFound, "No such data source.");
    return synced;
  } catch (error) {
    await prisma.dataSource.updateMany({
      where: { id: source.id, lastSyncStartedAt: startedAt },
      data: { lastSyncFinishedAt: new Date(), error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

/**
 * One step of the scheduler: claims and syncs the oldest source whose interval
 * has elapsed, or finishes deleting a source whose deletion had to wait for a
 * running sync. Returns whether it did anything, so the cron route can keep going
 * until the queue is empty or its time budget runs out.
 *
 * Sources are taken oldest-sync-first so that one source erroring quickly cannot
 * starve the others by being picked repeatedly.
 */
export async function runDueDataSourceSyncs(options: { deadlineMs: number }): Promise<{ didWork: boolean }> {
  if (Date.now() >= options.deadlineMs) return { didWork: false };

  // Claims in the same statement that selects. The cron fires every minute while
  // a sweep may run for minutes, so without a claim every overlapping invocation
  // would pick the same rows and sync one source several times at once —
  // causing concurrent slot reads and duplicate inserts.
  const due = await globalPrismaClient.$queryRaw<{ id: string, tenancyId: string, lastSyncStartedAt: Date, status: DataSource["status"] }[]>`
    UPDATE "DataSource"
    SET "lastSyncStartedAt" = NOW(), "error" = NULL
    WHERE "id" = (
      SELECT "id" FROM "DataSource"
      WHERE (
          -- A pending deletion is due as soon as the lease is free.
          "status" = 'DELETING'
          OR (
            "status" = 'ACTIVE'
            AND EXISTS (SELECT 1 FROM "DataSourceStream" s WHERE s."dataSourceId" = "DataSource"."id")
            AND (
              "lastSyncFinishedAt" IS NULL
              OR "lastSyncFinishedAt" < NOW() - make_interval(secs => "syncIntervalSeconds")
            )
          )
        )
        -- The lease: a claim older than this belonged to an invocation that died,
        -- so the row becomes eligible again rather than being stuck forever.
        AND (
          "lastSyncStartedAt" IS NULL
          OR "lastSyncStartedAt" <= "lastSyncFinishedAt"
          OR "lastSyncStartedAt" < NOW() - make_interval(secs => ${SYNC_CLAIM_LEASE_SECONDS})
        )
      ORDER BY ("status" = 'DELETING') DESC, "lastSyncFinishedAt" ASC NULLS FIRST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "tenancyId", "lastSyncStartedAt", "status"
  `;
  if (due.length === 0) return { didWork: false };

  for (const row of due) {
    try {
      const tenancy = await getTenancy(row.tenancyId);
      if (tenancy == null) throw new Error(`No tenancy exists for data source ${row.id}.`);
      if (row.status === "DELETING") {
        // Not entitlement-gated: a project that lost the plan still gets its
        // replication slot cleaned up.
        await removeDeletingDataSource(tenancy, row.id);
        continue;
      }
      await ensureDataWarehouseEntitlement(tenancy);
      const source = await findDataSource(tenancy, row.id);
      if (source == null) {
        // Deleted between the claim and this read. Releasing the lease is all it
        // takes for the next pass to finish the deletion.
        await globalPrismaClient.dataSource.updateMany({
          where: { id: row.id, lastSyncStartedAt: row.lastSyncStartedAt },
          data: { lastSyncFinishedAt: new Date() },
        });
        continue;
      }
      await syncClaimedDataSource(tenancy, source, row.lastSyncStartedAt);
    } catch (error) {
      // A source that cannot sync must not stop the sweep, and the failure is
      // already recorded on the row for the dashboard to show.
      captureError("data-source-scheduled-sync", error);
      // lastSyncFinishedAt is set so the interval applies to the retry too; the
      // status stays ACTIVE so a transient failure does not park the source.
      await globalPrismaClient.dataSource.updateMany({
        where: { id: row.id, lastSyncStartedAt: row.lastSyncStartedAt },
        data: { lastSyncFinishedAt: new Date(), error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return { didWork: true };
}
