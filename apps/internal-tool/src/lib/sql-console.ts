import { z } from "zod";

export const SQL_MAX_LENGTH = 16_000;
export const SQL_MAX_ROWS = 1_000;

/**
 * Every relation the console can read. The underlying log tables are private, so members query
 * them through these member-guarded views (full history, not the 200-row live views). Column
 * lists are not hardcoded here: the schema browser asks SpacetimeDB for them, so they can't drift
 * from the module.
 */
export const SQL_TABLES: ReadonlyArray<{ name: string, label: string, privateTable: string | null }> = [
  { name: "query_ai_usage", label: "AI usage", privateTable: "ai_query_log" },
  { name: "query_mcp_calls", label: "MCP calls", privateTable: "mcp_call_log" },
  { name: "query_feedback", label: "Feedback", privateTable: "feedback_log" },
  { name: "my_visible_qa_entries", label: "Knowledge base", privateTable: "qa_entries" },
  { name: "published_qa", label: "Published Q&A", privateTable: null },
];

/**
 * When SpacetimeDB rejects a query, point people who typed a private table name at the view that
 * exposes it — "no such table ai_query_log" is otherwise a confusing dead end.
 */
export function privateTableHint(sql: string): string | null {
  for (const table of SQL_TABLES) {
    if (table.privateTable != null && new RegExp(`\\b${table.privateTable}\\b`, "i").test(sql)) {
      return `${table.privateTable} is private. Query ${table.name} instead.`;
    }
  }
  return null;
}

export const DEFAULT_SQL = 'SELECT *\nFROM query_ai_usage\nLIMIT 100';

/**
 * The console accepts one SELECT, bounded to SQL_MAX_ROWS. A missing trailing LIMIT is appended
 * (exploratory queries shouldn't fail just for forgetting it); an explicit one must be in range.
 * This scanner
 * treats quoted text separately so semicolons inside strings are not statements.
 * SpacetimeDB still parses the SQL and enforces the caller's table permissions.
 */
export function validateConsoleSql(input: string): string {
  if (input.length > SQL_MAX_LENGTH) throw new Error(`Queries must be at most ${SQL_MAX_LENGTH} characters.`);
  const sql = input.trim().replace(/;\s*$/, "").trim();
  let unquoted = "";
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] === "\\") throw new Error("Use doubled quotes instead of backslash escapes.");
        if (sql[i] !== quote) continue;
        if (sql[i + 1] === quote) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error("Close all quoted strings and identifiers.");
      unquoted += " quoted ";
    } else {
      if (char === ";" || (char === "-" && sql[i + 1] === "-") || (char === "/" && sql[i + 1] === "*")) {
        throw new Error("Run one SELECT statement, without SQL comments.");
      }
      unquoted += char;
    }
  }
  if (!/^SELECT\s/i.test(unquoted)) throw new Error("Only SELECT queries are supported.");
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|SET|COPY|INTO)\b/i.test(unquoted)) {
    throw new Error("Only read-only SELECT queries are supported.");
  }
  const limit = /\bLIMIT\s+([0-9]+)\s*$/i.exec(unquoted);
  if (limit == null) {
    // A LIMIT anywhere but the end (eg. "LIMIT -1", or followed by more clauses) is malformed; only
    // a query with no LIMIT at all gets the default appended.
    if (/\bLIMIT\b/i.test(unquoted)) throw new Error(`End the query with LIMIT 1–${SQL_MAX_ROWS}.`);
    return `${sql}\nLIMIT ${SQL_MAX_ROWS}`;
  }
  if (Number(limit[1]) < 1 || Number(limit[1]) > SQL_MAX_ROWS) {
    throw new Error(`LIMIT must be between 1 and ${SQL_MAX_ROWS}.`);
  }
  return sql;
}

export const sqlResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  elapsedMs: z.number().nonnegative(),
}).superRefine((result, ctx) => {
  if (result.rows.length > SQL_MAX_ROWS || result.rows.some(row => row.length !== result.columns.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid SQL result dimensions." });
  }
});
export type SqlResult = z.infer<typeof sqlResultSchema>;

export function formatSqlCell(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "some" in value) return formatSqlCell(value.some);
  if (typeof value === "object" && "none" in value) return "NULL";
  return JSON.stringify(value);
}
