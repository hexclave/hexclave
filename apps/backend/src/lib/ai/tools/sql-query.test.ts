import type { SmartRequestAuth } from "@/route-handlers/smart-request";
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
  it("does not register queryAnalytics without a target project", async () => {
    const tools = await getTools(["sql-query"], {
      auth: null,
      targetProjectId: null,
    });

    expect(tools).not.toHaveProperty("queryAnalytics");
  });

  it("does not fall back to the caller's own project analytics when no target project is given", async () => {
    // Client-level auth for a customer project, as sent by anyone holding that
    // project's publishable client key. The AI endpoint accepts this auth level.
    const customerProjectClientAuth = {
      project: { id: "proj_customer" },
      branchId: "main",
      tenancy: { project: { id: "proj_customer" }, branchId: "main" },
      type: "client",
    } as unknown as SmartRequestAuth;

    const tools = await getTools(["sql-query"], {
      auth: customerProjectClientAuth,
      targetProjectId: null,
    });

    expect(tools).not.toHaveProperty("queryAnalytics");
  });

  it("registers queryAnalytics when a target project is present", async () => {
    const tools = await getTools(["sql-query"], {
      auth: null,
      targetProjectId: "proj_managed",
    });

    expect(tools).toHaveProperty("queryAnalytics");
  });
});
