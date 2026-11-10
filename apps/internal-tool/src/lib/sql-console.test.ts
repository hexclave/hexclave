import { describe, expect, it } from "vitest";
import { DEFAULT_SQL, formatSqlCell, privateTableHint, SQL_MAX_LENGTH, sqlResultSchema, validateConsoleSql } from "./sql-console";

describe("SQL console validation", () => {
  it("accepts a bounded SELECT, quoted columns and an optional trailing semicolon", () => {
    expect(validateConsoleSql(DEFAULT_SQL + ";")).toBe(DEFAULT_SQL);
    expect(validateConsoleSql(" select * from query_ai_usage limit 1000; ")).toBe("select * from query_ai_usage limit 1000");
    expect(validateConsoleSql('SELECT "userId" FROM query_ai_usage WHERE "userId" = \'a;--b\' LIMIT 1')).toContain("a;--b");
    expect(validateConsoleSql("SELECT * FROM query_mcp_calls WHERE question = 'it''s fine' LIMIT 1")).toContain("it''s");
  });
  it.each([
    "", "DELETE FROM query_ai_usage", "UPDATE query_ai_usage SET id = 1",
    "SELECT * FROM query_ai_usage LIMIT 0",
    "SELECT * FROM query_ai_usage LIMIT 1001", "SELECT * FROM query_ai_usage LIMIT -1",
    "SELECT * FROM query_ai_usage LIMIT 1; DELETE FROM query_ai_usage",
    "SELECT * INTO other_table FROM query_ai_usage LIMIT 1",
    "SELECT * FROM query_ai_usage -- comment\nLIMIT 1",
    "SELECT * FROM query_ai_usage /* comment */ LIMIT 1",
    "SELECT * FROM query_ai_usage WHERE id = 'unclosed LIMIT 1",
    "SELECT * FROM query_ai_usage WHERE id = E'\\'; DELETE FROM query_ai_usage LIMIT 1",
    "SELECT * FROM query_ai_usage LIMIT 1;;",
    "SELECT * FROM query_ai_usage LIMIT 10 WHERE id = 1",
  ])("rejects %s", sql => expect(() => validateConsoleSql(sql)).toThrow());
  it("appends the maximum LIMIT when none is given", () => {
    expect(validateConsoleSql("SELECT * FROM query_ai_usage;")).toMatchInlineSnapshot(`
      "SELECT * FROM query_ai_usage
      LIMIT 1000"
    `);
    // A LIMIT inside a string literal is data, not a clause, so the default is still appended.
    expect(validateConsoleSql("SELECT * FROM query_ai_usage WHERE id = 'LIMIT 1'")).toMatchInlineSnapshot(`
      "SELECT * FROM query_ai_usage WHERE id = 'LIMIT 1'
      LIMIT 1000"
    `);
  });
  it("points private table names at their member view", () => {
    expect(privateTableHint("select * from AI_QUERY_LOG")).toMatchInlineSnapshot(`"ai_query_log is private. Query query_ai_usage instead."`);
    expect(privateTableHint("SELECT * FROM query_ai_usage")).toBeNull();
    // Word boundaries: a column that merely contains a table name is not a hit.
    expect(privateTableHint("SELECT my_qa_entries_x FROM query_feedback")).toBeNull();
  });
  it("rejects oversized input", () => expect(() => validateConsoleSql(" ".repeat(SQL_MAX_LENGTH + 1))).toThrow());
  it("formats nullable and nested values", () => {
    expect([null, { none: [] }, { some: "abc" }, { some: false }, { x: [1, 2] }].map(formatSqlCell))
      .toMatchInlineSnapshot(`
        [
          "NULL",
          "NULL",
          "abc",
          "false",
          "{\"x\":[1,2]}",
        ]
      `);
  });
  it("validates result dimensions", () => {
    expect(sqlResultSchema.safeParse({ columns: ["x"], rows: [[1, 2]], elapsedMs: 0 }).success).toBe(false);
    expect(sqlResultSchema.safeParse({ columns: ["x"], rows: [[1]], elapsedMs: 0 }).success).toBe(true);
  });
});
