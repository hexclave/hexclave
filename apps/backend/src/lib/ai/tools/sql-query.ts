import { getClickhouseExternalClient } from "@/lib/clickhouse";
import { getSafeClickhouseErrorMessage } from "@/lib/clickhouse-errors";
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
  const branchId = targetProjectId ? "main" : auth.tenancy.branchId;

  // Max rows returned to the model (backstop if LIMIT is missing).
  const MAX_ROWS_FOR_AI = 50;

  return tool({
    description: `Set and validate a ClickHouse SQL query for the analytics data grid. The grid runs the full query independently — you only receive a preview of the first ${MAX_ROWS_FOR_AI} rows to confirm correctness. Only SELECT queries are allowed. Project filtering is automatic. Always include a LIMIT clause. Use SHOW TABLES to discover available tables and DESCRIBE TABLE <table_name> to see columns with types and descriptions.`,
    inputSchema: z.object({
      query: z
        .string()
        .describe("The ClickHouse SQL query to execute. Only SELECT queries are allowed. Always include a LIMIT clause unless the system prompt tells you to do otherwise."),
    }),
    execute: async ({ query }: { query: string }) => {
      const client = getClickhouseExternalClient();
      try {
        const resultSet = await client.query({
          query,
          clickhouse_settings: {
            SQL_project_id: projectId,
            SQL_branch_id: branchId,
            max_execution_time: 5,
            readonly: "1",
            allow_ddl: 0,
            max_result_rows: "10000",
            max_result_bytes: (10 * 1024 * 1024).toString(),
            result_overflow_mode: "throw",
          },
          format: "JSONEachRow",
        });
        const rows = await resultSet.json<Record<string, unknown>[]>();
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
