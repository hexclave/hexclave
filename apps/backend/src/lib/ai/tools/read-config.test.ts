import type { SmartRequestAuth } from "@/route-handlers/smart-request";
import { describe, expect, it } from "vitest";
import { getTools } from ".";
import { readConfigTool } from "./read-config";

// Client-level auth for a customer project, as sent by anyone holding that
// project's publishable client key. The AI endpoint accepts this auth level.
const customerProjectClientAuth = {
  project: { id: "proj_customer" },
  branchId: "main",
  tenancy: { project: { id: "proj_customer" }, branchId: "main" },
  type: "client",
} as unknown as SmartRequestAuth;

describe("readConfigTool", () => {
  it("does not create a config tool without a resolvable project target", () => {
    expect(readConfigTool(null)).toBeNull();
    expect(readConfigTool(undefined)).toBeNull();
  });

  it("creates a config tool for an explicit project target", () => {
    expect(readConfigTool("00000000-0000-0000-0000-000000000000")).not.toBeNull();
  });
});

describe("getTools", () => {
  it("omits readBranchConfig when read-config has no resolvable project target", async () => {
    await expect(getTools(["read-config"], {
      auth: null,
      targetProjectId: null,
    })).resolves.toEqual({});
  });

  it("does not fall back to the caller's own project config when no target project is given", async () => {
    await expect(getTools(["read-config"], {
      auth: customerProjectClientAuth,
      targetProjectId: null,
    })).resolves.toEqual({});
  });

  it("includes readBranchConfig when read-config has an explicit project target", async () => {
    const tools = await getTools(["read-config"], {
      auth: null,
      targetProjectId: "00000000-0000-0000-0000-000000000000",
    });

    expect(tools).toHaveProperty("readBranchConfig");
  });
});
