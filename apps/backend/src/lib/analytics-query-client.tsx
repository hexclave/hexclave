import { WAREHOUSE_ANALYTICS_CLICKHOUSE_SETTINGS, createClickhouseWarehouseClient, getClickhouseExternalClient, type ClickHouseClient } from "@/lib/clickhouse";
import { getDataWarehouseQueryAuth } from "@/lib/data-warehouse";
import type { Tenancy } from "@/lib/tenancies";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

/**
 * Settings every user- or agent-authored analytics query must carry, whichever
 * ClickHouse user runs it.
 *
 * `readonly`/`allow_ddl` matter most for a Data Warehouse user: unlike
 * `limited_user`, it can write to and drop tables in its own database, and these
 * queries come from the dashboard grid or an AI tool, never from a direct
 * connection the customer controls.
 */
type AnalyticsQuerySettings = {
  readonly: "1",
  allow_ddl: 0,
  SQL_project_id?: string,
  SQL_branch_id?: string,
};

/**
 * Runs `fn` with the ClickHouse client an analytics query for `tenancy` should use,
 * shared by `/analytics/query` and the AI SQL tool so the two cannot drift.
 *
 * Projects with a Data Warehouse connect as their own ClickHouse user instead of
 * the shared `limited_user`, so queries can also reach their own database. That
 * user holds `analytics_reader`, so analytics access is unchanged.
 *
 * Its `SQL_project_id`/`SQL_branch_id` are pinned as CONST user settings, so they
 * must not be sent per query — ClickHouse rejects setting a CONST setting at all.
 * `limited_user` is shared across projects and needs them on every query.
 *
 * The shared client bakes its resource ceiling in at construction; the warehouse
 * client does the same, or a warehouse project would fall back to the much looser
 * per-query memory default of its own settings profile and skip the GROUP BY spill
 * and bounded join algorithm entirely. The shared client is reused across
 * requests; a warehouse client is per call and closed afterwards to release its
 * HTTP agent and sockets.
 */
export async function withAnalyticsQueryClient<T>(
  tenancy: Tenancy,
  fn: (client: ClickHouseClient, settings: AnalyticsQuerySettings) => Promise<T>,
): Promise<T> {
  const warehouseAuth = await getDataWarehouseQueryAuth(tenancy);
  if (warehouseAuth == null) {
    return await fn(getClickhouseExternalClient(), {
      readonly: "1",
      allow_ddl: 0,
      SQL_project_id: tenancy.project.id,
      SQL_branch_id: tenancy.branchId,
    });
  }
  const client = createClickhouseWarehouseClient(
    warehouseAuth,
    getEnvVariable("STACK_CLICKHOUSE_DATABASE", "default"),
    WAREHOUSE_ANALYTICS_CLICKHOUSE_SETTINGS,
  );
  try {
    return await fn(client, { readonly: "1", allow_ddl: 0 });
  } finally {
    await client.close();
  }
}
