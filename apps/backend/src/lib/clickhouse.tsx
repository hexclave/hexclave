import { createClient, type ClickHouseClient, type ClickHouseSettings } from "@clickhouse/client";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

// Re-exported so other modules can hold a typed ClickHouse client (e.g. to
// thread a single warmed client through helpers) without taking a direct
// dependency on the @clickhouse/client package.
export type { ClickHouseClient } from "@clickhouse/client";

function getAdminAuth() {
  return {
    username: getEnvVariable("STACK_CLICKHOUSE_ADMIN_USER", "stackframe"),
    password: getEnvVariable("STACK_CLICKHOUSE_ADMIN_PASSWORD"),
  };
}

export function createClickhouseClient(
  authType: "admin" | "external",
  database?: string,
  clickhouse_settings?: ClickHouseSettings,
) {
  return createClient({
    url: getEnvVariable("STACK_CLICKHOUSE_URL"),
    ...authType === "admin" ? getAdminAuth() : {
      username: "limited_user",
      password: getEnvVariable("STACK_CLICKHOUSE_EXTERNAL_PASSWORD"),
    },
    database,
    request_timeout: 10 * 60 * 1000, // 10 minutes
    clickhouse_settings,
  });
}

export function getClickhouseAdminClient() {
  return createClickhouseClient("admin", getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"));
}

const BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  max_bytes_before_external_group_by: "256000000",
  max_memory_usage: "512000000",
  max_memory_usage_for_user: "9000000000",
  // SDK type narrows to a single algorithm; the server accepts a fallback list.
  join_algorithm: "grace_hash,parallel_hash,hash" as ClickHouseSettings["join_algorithm"],
};

// Every query through limited_user is ultimately user- or agent-authored, including the dashboard
// analytics endpoint and both AI SQL tools. Keep the resource ceiling at the client boundary so a
// new caller cannot accidentally bypass it by omitting per-query settings. GROUP BYs spill before
// reaching the per-query cap, large joins use bounded partitions, and the shared-user cap prevents
// concurrent external queries from exhausting the whole ClickHouse cluster.
export const EXTERNAL_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS,
};

export function getClickhouseExternalClient() {
  return createClickhouseClient(
    "external",
    getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"),
    EXTERNAL_CLICKHOUSE_SETTINGS,
  );
}

// Safety net for heavy analytical reads against `analytics_internal.events`:
// GROUP BY spills to disk at ~50% of the per-query cap (leaving headroom for
// the post-spill merge), grace_hash partitions large join build sides instead
// of allocating one giant hash table, and the per-user cap bounds total
// concurrent memory against the cluster's 10.8 GiB OvercommitTracker. Values
// are decimal bytes (how ClickHouse parses digit strings).
//
// Note: max_memory_usage_for_user is enforced ClickHouse-side per *connecting
// user* (the shared `stackframe` admin), so all admin queries — not just this
// client's — count toward the same 9 GB budget. With the 30-day bounds each
// metrics query peaks well under 100 MiB, so practical interference is low.
export const METRICS_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
  ...BOUNDED_ANALYTICS_CLICKHOUSE_SETTINGS,
};

export function getClickhouseAdminClientForMetrics() {
  return createClickhouseClient(
    "admin",
    getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"),
    METRICS_CLICKHOUSE_SETTINGS,
  );
}

export const getQueryTimingStats = async (client: ClickHouseClient, queryId: string) => {
  // Flush logs to ensure system.query_log has latest query result.
  // Todo: for performance we should instead poll for this row to become available asynchronously after returning result. Flushed every 7.5 seconds by default
  await client.exec({
    query: "SYSTEM FLUSH LOGS",
    auth: getAdminAuth(),
  });
  const queryProfile = async () => {
    const profile = await client.query({
      query: `
      SELECT
        ProfileEvents['CPUTimeMicroseconds'] / 1000 AS cpu_time_ms,
        ProfileEvents['RealTimeMicroseconds'] / 1000 AS wall_clock_time_ms
      FROM system.query_log
      WHERE query_id = {query_id:String} AND type = 'QueryFinish'
      ORDER BY event_time DESC
      LIMIT 1
    `,
      query_params: { query_id: queryId },
      auth: getAdminAuth(),
      format: "JSON",
    });

    return await profile.json<{
      cpu_time_ms: number,
      wall_clock_time_ms: number,
    }>();
  };

  const retryDelaysMs = [75, 150, 300, 600, 1200];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const stats = await queryProfile();
    if (stats.data.length === 1) {
      return stats.data[0];
    }
    if (stats.data.length > 1) {
      throw new HexclaveAssertionError(`Unexpected number of query log results: ${stats.data.length}`, { data: stats.data });
    }
    if (attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  throw new HexclaveAssertionError("Unexpected number of query log results: 0", { data: [] });
};

export const getQueryTimingStatsForProject = async (
  client: ClickHouseClient,
  queryId: string,
) => {
  const queryProfile = async () => {
    const profile = await client.query({
      query: `
      SELECT
        ProfileEvents['CPUTimeMicroseconds'] / 1000 AS cpu_time_ms,
        ProfileEvents['RealTimeMicroseconds'] / 1000 AS wall_clock_time_ms
      FROM system.query_log
      WHERE query_id = {query_id:String}
        AND type = 'QueryFinish'
      ORDER BY event_time DESC
      LIMIT 1
    `,
      query_params: {
        query_id: queryId,
      },
      auth: getAdminAuth(),
      format: "JSON",
    });

    return await profile.json<{
      cpu_time_ms: number,
      wall_clock_time_ms: number,
    }>();
  };

  const retryDelaysMs = [75, 150, 300, 600, 1200, 2400, 4800];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const stats = await queryProfile();
    if (stats.data.length === 1) {
      return stats.data[0];
    }
    if (stats.data.length > 1) {
      throw new HexclaveAssertionError(`Unexpected number of query log results: ${stats.data.length}`, { data: stats.data });
    }
    if (attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  return null;
};
