import type { DataSource, DataSourceStream } from "@/generated/prisma/client";
import {
  DATA_SOURCE_SYNC_MODES,
  getDefaultCursorColumn,
  getModeAvailability,
  getRecommendedMode,
  type DataSourceCapabilities,
} from "@hexclave/shared/dist/data-sources/modes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import type { DataSourceProbeResult } from "./probe";

const MODE_FROM_PRISMA = {
  CURSOR: "cursor",
  CDC: "cdc",
} as const;

const STATUS_FROM_PRISMA = {
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  FAILED: "failed",
} as const;

const STREAM_STATUS_FROM_PRISMA = {
  PENDING: "pending",
  SNAPSHOTTING: "snapshotting",
  ACTIVE: "active",
  FAILED: "failed",
} as const;

export function serializeStream(stream: DataSourceStream) {
  return {
    id: stream.id,
    schema_name: stream.schemaName,
    table_name: stream.tableName,
    mode: MODE_FROM_PRISMA[stream.mode],
    cursor_column: stream.cursorColumn,
    primary_key_columns: stream.primaryKeyColumns,
    destination_table: stream.destinationTable,
    status: STREAM_STATUS_FROM_PRISMA[stream.status],
    error: stream.error,
    // BigInt does not survive JSON, and a row count is never precise enough for
    // the extra digits to matter.
    rows_synced: Number(stream.rowsSynced),
    last_synced_at_millis: stream.lastSyncedAt?.getTime() ?? null,
  };
}

export function serializeDataSource(source: DataSource & { streams: DataSourceStream[] }) {
  const capabilities = (source.capabilities ?? null) as DataSourceCapabilities | null;
  return {
    id: source.id,
    type: "postgres" as const,
    host: source.host,
    port: source.port,
    database: source.database,
    username: source.username,
    ssl_mode: source.sslMode,
    // DELETING sources are filtered out of every read, so one reaching here is a bug.
    status: source.status === "DELETING"
      ? throwErr(`Data source ${source.id} is being deleted and must not be serialized`)
      : STATUS_FROM_PRISMA[source.status],
    error: source.error,
    sync_interval_seconds: source.syncIntervalSeconds,
    capabilities: capabilities == null ? null : {
      version: capabilities.version,
      wal_level: capabilities.walLevel,
      has_replication: capabilities.hasReplication,
      in_recovery: capabilities.inRecovery,
      slots_used: capabilities.slotsUsed,
      slots_max: capabilities.slotsMax,
      probed_at_millis: capabilities.probedAtMillis,
    },
    last_sync_started_at_millis: source.lastSyncStartedAt?.getTime() ?? null,
    last_sync_finished_at_millis: source.lastSyncFinishedAt?.getTime() ?? null,
    streams: source.streams.map(serializeStream),
  };
}

/**
 * The catalog the "choose tables" screen renders. Mode availability is resolved
 * here rather than in the dashboard so that what is offered and what the backend
 * will accept can never drift apart.
 */
export function serializeCatalog(probe: DataSourceProbeResult) {
  return {
    capabilities: {
      version: probe.capabilities.version,
      wal_level: probe.capabilities.walLevel,
      has_replication: probe.capabilities.hasReplication,
      in_recovery: probe.capabilities.inRecovery,
      slots_used: probe.capabilities.slotsUsed,
      slots_max: probe.capabilities.slotsMax,
      probed_at_millis: probe.capabilities.probedAtMillis,
    },
    tables: probe.tables.map(table => {
      const availability = getModeAvailability(table, probe.capabilities);
      return {
        schema_name: table.schemaName,
        table_name: table.tableName,
        approx_rows: table.approxRows,
        replica_identity: table.replicaIdentity,
        is_partitioned: table.isPartitioned,
        primary_key_columns: table.primaryKeyColumns,
        cursor_candidates: table.cursorCandidates.map(candidate => ({
          column: candidate.column,
          data_type: candidate.dataType,
          indexed: candidate.indexed,
        })),
        available_modes: DATA_SOURCE_SYNC_MODES.map(mode => ({
          mode,
          available: availability[mode].available,
          reason: availability[mode].reason,
        })),
        recommended_mode: getRecommendedMode(table, probe.capabilities),
        default_cursor_column: getDefaultCursorColumn(table),
      };
    }),
  };
}
