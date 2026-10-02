import type { ClickHouseClient } from "@/lib/clickhouse";

/**
 * `analytics_internal.issue_occurrence_rollup` is a read-only VIEW over a
 * versioned storage table (see scripts/clickhouse-derived-rebuild.ts). Row
 * mutations must target the storage tables themselves.
 */
export async function deleteFromIssueOccurrenceRollup(
  client: ClickHouseClient,
  options: { whereSql: string, queryParams: Record<string, unknown> },
): Promise<void> {
  const resultSet = await client.query({
    query: `
      SELECT name
      FROM system.tables
      WHERE database = 'analytics_internal'
        AND (name = 'issue_occurrence_rollup' OR startsWith(name, 'issue_occurrence_rollup__v'))
        AND engine = 'AggregatingMergeTree'
    `,
    format: "JSONEachRow",
  });
  const tables = (await resultSet.json<{ name: string }>()).map((row) => row.name);
  for (const table of tables) {
    await client.command({
      query: `ALTER TABLE analytics_internal.${table} DELETE WHERE ${options.whereSql}`,
      query_params: options.queryParams,
    });
  }
}
