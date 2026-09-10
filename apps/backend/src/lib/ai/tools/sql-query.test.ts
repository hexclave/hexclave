import { describe, expect, it } from "vitest";
import { getTools } from ".";
import { createSqlQueryTool } from "./sql-query";

describe("createSqlQueryTool", () => {
  // Unlike returning null (which would make the tool silently disappear from the
  // model's toolset), unauthenticated requests get a stub tool whose result tells
  // the model to ask the user to sign in.
  it("returns a stub tool that surfaces the sign-in requirement when unauthenticated", async () => {
    const sqlTool = createSqlQueryTool(null);
    expect(sqlTool).not.toBeNull();
    const result = await sqlTool.execute?.({ query: "SELECT 1" }, { toolCallId: "test-call", messages: [] });
    expect(result).toMatchInlineSnapshot(`
      {
        "error": "Authentication required. The user is not signed in, so analytics queries cannot run. Inform the user that they need to sign in to access analytics.",
      }
    `);
  });
});

describe("getTools", () => {
  it("exposes queryAnalytics even without auth so the model sees the auth requirement instead of a missing tool", async () => {
    const tools = await getTools(["sql-query"], {
      auth: null,
      targetProjectId: null,
    });

    expect(tools).toHaveProperty("queryAnalytics");
  });
});
