import { withAnalyticsQueryClient } from "@/lib/analytics-query-client";
import { getSafeClickhouseErrorMessage } from "@/lib/clickhouse-errors";
import { getDataWarehouseNames } from "@/lib/data-warehouse";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import { SmartRequestAuth } from "@/route-handlers/smart-request";
import { ClickHouseError } from "@clickhouse/client";
import { tool } from "ai";
import { z } from "zod";

export const SQL_QUERY_RESULT_MAX_CHARS = 50_000;

export function createSqlQueryTool(auth: SmartRequestAuth | null, targetProjectId?: string | null) {
  if (auth == null) {
    // Return a stub tool that surfaces the auth requirement to the model as a tool
    // result, instead of throwing. This way the model can react gracefully (e.g. tell
    // the user to sign in) rather than the request failing with a 4xx the model never sees.
    return tool({
      description: "Run analytics SQL queries. Currently unavailable: this tool requires the user to be signed in. If the user asks an analytics question, explain that they need to sign in first instead of calling this tool.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async () => ({
        error: "Authentication required. The user is not signed in, so analytics queries cannot run. Inform the user that they need to sign in to access analytics.",
      }),
    });
  }

  const projectId = targetProjectId ?? auth.tenancy.project.id;
  // A target project is always queried on its default branch (the AI route has
  // already checked access to it). Resolved lazily so building the toolset stays
  // cheap when the model never calls this tool.
  const getTenancy = async () => targetProjectId == null
    ? auth.tenancy
    : await getSoleTenancyFromProjectBranch(targetProjectId, DEFAULT_BRANCH_ID);
  const warehouseDatabaseName = getDataWarehouseNames(projectId).databaseName;

  // Max rows returned to the model (backstop if LIMIT is missing).
  const MAX_ROWS_FOR_AI = 50;

  return tool({
    description: `Set and validate a ClickHouse SQL query for the analytics data grid. The grid runs the full query independently — you only receive a preview of the first ${MAX_ROWS_FOR_AI} rows to confirm correctness. Only SELECT queries are allowed. Project filtering is automatic. Always include a LIMIT clause. Use SHOW TABLES to discover available tables and DESCRIBE TABLE <table_name> to see columns with types and descriptions. If the project has a Data Warehouse, its own tables are in the database \`${warehouseDatabaseName}\` (SHOW TABLES FROM \`${warehouseDatabaseName}\`); without one, that database is not accessible.`,
    inputSchema: z.object({
      query: z
        .string()
        .describe("The ClickHouse SQL query to execute. Only SELECT queries are allowed. Always include a LIMIT clause unless the system prompt tells you to do otherwise."),
    }),
    execute: async ({ query }: { query: string }) => {
      const tenancy = await getTenancy();
      try {
        const rows = await withAnalyticsQueryClient(tenancy, async (client, analyticsSettings) => {
          const resultSet = await client.query({
            query,
            clickhouse_settings: {
              ...analyticsSettings,
              max_execution_time: 5,
              max_result_rows: "10000",
              max_result_bytes: (10 * 1024 * 1024).toString(),
              result_overflow_mode: "throw",
            },
            format: "JSONEachRow",
          });
          // Read the rows before the helper closes a per-call warehouse client.
          return await resultSet.json<Record<string, unknown>[]>();
        });
        const truncated = rows.length > MAX_ROWS_FOR_AI;
        const returnedRows = truncated ? rows.slice(0, MAX_ROWS_FOR_AI) : rows;
        const response = {
          success: true as const,
          rowCount: returnedRows.length,
          totalRows: rows.length,
          truncated,
          ...(truncated
            ? { truncationNote: `Only the first ${MAX_ROWS_FOR_AI} of ${rows.length} rows are shown. Add LIMIT or aggregate to see the rest.` }
            : {}),
          result: returnedRows,
        };
        const serialized = JSON.stringify(response);
        if (serialized.length > SQL_QUERY_RESULT_MAX_CHARS) {
          return {
            success: false as const,
            error:
              `Result too large: ${rows.length} rows, ${serialized.length} characters (limit ${SQL_QUERY_RESULT_MAX_CHARS}). ` +
              `To fix: ` +
              `(1) Use aggregation (COUNT, uniqExact, GROUP BY, topK, quantile) instead of fetching rows. ` +
              `(2) If you need rows, add a WHERE clause or reduce LIMIT. ` +
              `(3) Select only the columns you need — avoid the 'data' column on events unless essential.`,
            rowCount: rows.length,
            characters: serialized.length,
            columnsReturned: rows.length > 0 ? Object.keys(rows[0]) : [],
          };
        }
        return response;
      } catch (error) {
        if (!(error instanceof ClickHouseError)) {
          throw error;
        }
        return {
          success: false as const,
          error: getSafeClickhouseErrorMessage(error, query),
        };
      }
    },
  });
}
