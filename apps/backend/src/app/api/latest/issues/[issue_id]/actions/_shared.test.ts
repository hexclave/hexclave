import type { resolveIssueIdentity } from "@/lib/issues/issue-identity";
import { IssueNotFoundError } from "@/lib/issues/issue-lifecycle";
import type { Tenancy } from "@/lib/tenancies";
import { applyOrganizationDefaults, sanitizeOrganizationConfig } from "@hexclave/shared/dist/config/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIssueActionTarget } from "./_shared";

const resolveIdentity = vi.fn<Parameters<typeof resolveIssueIdentity>, ReturnType<typeof resolveIssueIdentity>>();

const tenancy = {
  id: "123e4567-e89b-42d3-a456-426614174001",
  config: await sanitizeOrganizationConfig(applyOrganizationDefaults({})),
  branchId: "main",
  organization: null,
  project: {
    id: "project-id",
    display_name: "Issue action test project",
    description: "",
    created_at_millis: 0,
    is_production_mode: false,
    is_development_environment: true,
    owner_team_id: null,
    onboarding_status: "completed",
    pushed_config_error: null,
    config_warnings: [],
  },
} satisfies Tenancy;

describe("issue action target resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the primary when retrying a mutation that lost a merge race", async () => {
    resolveIdentity
      .mockResolvedValueOnce({ issueId: "11111111-1111-4111-8111-111111111111", redirectedFromIssueId: null })
      .mockResolvedValueOnce({
        issueId: "22222222-2222-4222-8222-222222222222",
        redirectedFromIssueId: "11111111-1111-4111-8111-111111111111",
      });
    const action = vi.fn()
      .mockRejectedValueOnce(new IssueNotFoundError({
        tenancy,
        issueId: "11111111-1111-4111-8111-111111111111",
      }))
      .mockResolvedValueOnce("updated");

    await expect(withIssueActionTarget({
      tenancy,
      rawIssueId: "11111111-1111-4111-8111-111111111111",
      action,
      resolveIdentity,
    })).resolves.toMatchObject({
      target: { issueId: "22222222-2222-4222-8222-222222222222" },
      result: "updated",
    });

    expect(resolveIdentity).toHaveBeenNthCalledWith(1, expect.anything(), "11111111-1111-4111-8111-111111111111", { consistency: "replica" });
    expect(resolveIdentity).toHaveBeenNthCalledWith(2, expect.anything(), "11111111-1111-4111-8111-111111111111", { consistency: "primary" });
  });
});
