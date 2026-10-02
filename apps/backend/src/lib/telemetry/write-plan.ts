import type { ClickHouseClient } from "@/lib/clickhouse";

export type TelemetryWriteDestination = {
  table: "analytics_internal.events";
  values: unknown[];
  deduplicationToken: string;
};

export type TelemetryWritePlan<TIssueInput> = {
  batchId: string;
  destinations: TelemetryWriteDestination[];
  issueInputs: TIssueInput[];
};

export async function writeTelemetryDestinations(
  client: ClickHouseClient,
  destinations: readonly TelemetryWriteDestination[],
): Promise<void> {
  await Promise.all(destinations.map(async (destination) => {
    if (destination.values.length === 0) return;
    await client.insert({
      table: destination.table,
      values: destination.values,
      format: "JSONEachRow",
      clickhouse_settings: {
        date_time_input_format: "best_effort",
        async_insert: 0,
        wait_for_async_insert: 1,
        insert_deduplication_token: destination.deduplicationToken,
        deduplicate_blocks_in_dependent_materialized_views: 1,
      },
    });
  }));
}
