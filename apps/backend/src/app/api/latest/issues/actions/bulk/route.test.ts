import type { SmartRequest } from "@/route-handlers/smart-request";
import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { applyOrganizationDefaults, sanitizeOrganizationConfig } from "@hexclave/shared/dist/config/schema";
import { vi, describe, expect, it } from "vitest";

const mocks = vi.hoisted(() => ({
  assertIssueActionsEnabled: vi.fn(),
  transitionIssueStatus: vi.fn(),
  withIssueActionTarget: vi.fn(),
}));

vi.mock("@/route-handlers/smart-route-handler", () => ({
  createSmartRouteHandler: (definition: {
    request: { validate: (value: unknown, options?: unknown) => Promise<unknown> },
    handler: (value: unknown) => Promise<unknown>,
  }) => ({
    overloads: new Map([[undefined, definition]]),
    invoke: async (request: unknown) => {
      const validated = await definition.request.validate(request, { context: { noUnknownPathPrefixes: ["body", "query", "params"] } });
      return await definition.handler(validated);
    },
  }),
}));

vi.mock("@/prisma-client", () => ({
  getPrismaClientForTenancy: vi.fn(),
  retryTransaction: vi.fn(),
}));

vi.mock("@/lib/issues/issue-lifecycle", () => ({
  transitionIssueStatus: mocks.transitionIssueStatus,
  IssueLifecycleInputError: class IssueLifecycleInputError extends Error {},
  IssueNotFoundError: class IssueNotFoundError extends Error {},
}));

vi.mock("../../[issue_id]/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../[issue_id]/actions/_shared")>();
  return {
    ...actual,
    assertIssueActionsEnabled: mocks.assertIssueActionsEnabled,
    withIssueActionTarget: mocks.withIssueActionTarget,
  };
});

import { BulkIssueStatusBodySchema, POST as bulkStatus } from "./route";
import { MAX_BULK_ISSUE_IDS } from "./bulk-status";

const tenancy = {
  id: "123e4567-e89b-42d3-a456-426614174001",
  config: await sanitizeOrganizationConfig(applyOrganizationDefaults({})),
  branchId: "branch-a",
  organization: null,
  project: {
    id: "123e4567-e89b-42d3-a456-426614174002",
    display_name: "Bulk issue action test project",
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

function request(body: unknown, type: "client" | "server" | "admin" = "server"): SmartRequest {
  return {
    auth: {
      type,
      project: tenancy.project,
      branchId: tenancy.branchId,
      tenancy,
    },
    url: "http://localhost/api/latest/issues/actions/bulk",
    method: "POST",
    body,
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: {},
    params: {},
    clientVersion: undefined,
  };
}

function transition(status: "resolved" | "ignored" | "unresolved", issueId: string) {
  return {
    tenancyId: tenancy.id,
    issueId,
    kind: "status_changed" as const,
    at: new Date("2026-08-06T12:00:00.000Z"),
    previous: {
      status: "unresolved" as const,
      statusChangedAt: null,
      resolvedAt: null,
      ignoredUntil: null,
      regressedAt: null,
      assigneeUserId: null,
    },
    current: {
      status,
      statusChangedAt: new Date("2026-08-06T12:00:00.000Z"),
      resolvedAt: status === "resolved" ? new Date("2026-08-06T12:00:00.000Z") : null,
      ignoredUntil: null,
      regressedAt: null,
      assigneeUserId: null,
      kind: "status_changed" as const,
    },
  };
}

describe("bulk issue status action contract", () => {
  it("accepts UUIDs and short ids, rejects duplicates, malformed ids, and oversized lists", async () => {
    const issueId = "123e4567-e89b-42d3-a456-426614174000";
    await expect(BulkIssueStatusBodySchema.validate({
      status: "resolved",
      issue_ids: [issueId, "42"],
    })).resolves.toMatchObject({ status: "resolved", issue_ids: [issueId, "42"] });

    await expect(BulkIssueStatusBodySchema.validate({
      status: "resolved",
      issue_ids: [issueId, issueId],
    })).rejects.toThrow();
    await expect(BulkIssueStatusBodySchema.validate({
      status: "resolved",
      issue_ids: ["not-an-issue-id"],
    })).rejects.toThrow();
    await expect(BulkIssueStatusBodySchema.validate({
      status: "resolved",
      issue_ids: Array.from({ length: MAX_BULK_ISSUE_IDS + 1 }, (_value, index) => String(index + 1)),
    })).rejects.toThrow();
  });

  it("applies every requested status in order and returns changed/status fields", async () => {
    mocks.withIssueActionTarget.mockImplementation(async ({ rawIssueId, action }: {
      rawIssueId: string,
      action: (target: { issueId: string, redirectedFromIssueId: string | null }) => Promise<unknown>,
    }) => {
      const target = {
        issueId: rawIssueId === "42" ? "223e4567-e89b-42d3-a456-426614174000" : rawIssueId,
        redirectedFromIssueId: null,
      };
      return { target, result: await action(target) };
    });
    mocks.transitionIssueStatus.mockImplementation(async ({ issueId, mutation }: {
      issueId: string,
      mutation: { status: "resolved" | "ignored" | "unresolved" },
    }) => transition(mutation.status, issueId));

    const response = await bulkStatus.invoke(request({
      status: "resolved",
      issue_ids: ["123e4567-e89b-42d3-a456-426614174000", "42"],
    }));

    expect(response.body).toMatchObject({
      status: "resolved",
      results: [
        {
          input_issue_id: "123e4567-e89b-42d3-a456-426614174000",
          issue_id: "123e4567-e89b-42d3-a456-426614174000",
          action: "resolve",
          changed: true,
          status: "resolved",
          redirected: false,
          error: null,
        },
        {
          input_issue_id: "42",
          issue_id: "223e4567-e89b-42d3-a456-426614174000",
          action: "resolve",
          changed: true,
          status: "resolved",
          redirected: false,
          error: null,
        },
      ],
    });
    expect(response.body.results[0]).not.toHaveProperty("previous_assignee_user_id");
    expect(response.body.results[0]).not.toHaveProperty("assignee_user_id");
    expect(mocks.assertIssueActionsEnabled).toHaveBeenCalledWith(tenancy);
  });

  it("preserves redirect metadata and redacts missing or foreign targets", async () => {
    mocks.withIssueActionTarget.mockImplementation(async ({ rawIssueId, action }: {
      rawIssueId: string,
      action: (target: { issueId: string, redirectedFromIssueId: string | null }) => Promise<unknown>,
    }) => {
      if (rawIssueId === "323e4567-e89b-42d3-a456-426614174000") {
        throw new StatusError(StatusError.NotFound, "Issue not found");
      }
      const target = rawIssueId === "314159"
        ? { issueId: "423e4567-e89b-42d3-a456-426614174000", redirectedFromIssueId: "523e4567-e89b-42d3-a456-426614174000" }
        : { issueId: rawIssueId, redirectedFromIssueId: null };
      return { target, result: await action(target) };
    });
    mocks.transitionIssueStatus.mockImplementation(async ({ issueId, mutation }: {
      issueId: string,
      mutation: { status: "resolved" | "ignored" | "unresolved" },
    }) => transition(mutation.status, issueId));

    const response = await bulkStatus.invoke(request({
      status: "ignored",
      issue_ids: ["314159", "323e4567-e89b-42d3-a456-426614174000"],
    }));

    expect(response.body.results).toEqual([
      expect.objectContaining({
        input_issue_id: "314159",
        issue_id: "423e4567-e89b-42d3-a456-426614174000",
        redirected: true,
        redirected_from_issue_id: "523e4567-e89b-42d3-a456-426614174000",
        changed: true,
        status: "ignored",
        error: null,
      }),
      expect.objectContaining({
        input_issue_id: "323e4567-e89b-42d3-a456-426614174000",
        issue_id: null,
        redirected: false,
        changed: false,
        status: null,
        error: "not_found",
      }),
    ]);
  });

  it("rejects client auth, unknown body fields, and malformed requests before mutation", async () => {
    const issueId = "123e4567-e89b-42d3-a456-426614174000";
    await expect(bulkStatus.invoke(request({ status: "resolved", issue_ids: [issueId] }, "client")))
      .rejects.toThrow();
    await expect(bulkStatus.invoke(request({ status: "resolved", issue_ids: ["not-an-issue-id"] })))
      .rejects.toThrow();
    await expect(bulkStatus.invoke(request({ status: "resolved", issue_ids: [issueId], unexpected: true })))
      .rejects.toThrow();
  });
});
