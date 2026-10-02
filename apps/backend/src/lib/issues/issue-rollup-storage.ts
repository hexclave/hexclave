import type { ClickHouseClient } from "@/lib/clickhouse";

/**
 * `analytics_internal.issue_occurrence_rollup` is a read-only VIEW over a
 * versioned storage table (see scripts/clickhouse-derived-rebuild.ts). Row
 * mutations target only the storage table the reader currently serves from;
 * in-progress staging and retired versions are owned by the rebuild.
 */
export async function deleteFromIssueOccurrenceRollup(
  client: ClickHouseClient,
  options: { whereSql: string, queryParams: Record<string, unknown> },
): Promise<void> {
  const table = await liveIssueOccurrenceRollupStorage(client);
  if (table === null) return;
  await client.command({
    query: `ALTER TABLE analytics_internal.${table} DELETE WHERE ${options.whereSql}`,
    query_params: options.queryParams,
    clickhouse_settings: { mutations_sync: "2" },
  });
}

async function liveIssueOccurrenceRollupStorage(client: ClickHouseClient): Promise<string | null> {
  const resultSet = await client.query({
    query: `
      SELECT engine, as_select
      FROM system.tables
      WHERE database = 'analytics_internal' AND name = 'issue_occurrence_rollup'
    `,
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ engine: string, as_select: string }>();
  if (rows.length === 0) return null;
  const reader = rows[0];
  if (reader.engine === "AggregatingMergeTree") return "issue_occurrence_rollup";
  if (reader.engine !== "View") return null;
  const match = /\bFROM\s+`?analytics_internal`?\.`?(issue_occurrence_rollup__v[A-Za-z0-9_]+)`?\s*$/.exec(reader.as_select.trim());
  return match?.[1] ?? null;
}
