import { describe, expect, it } from "vitest";
import { evaluateIssueAlertRule } from "@/lib/issues/issue-alerts/evaluator";
import { resolveOwnershipRecipients } from "@/lib/issues/ownership/resolver";
import { buildOwnershipRoutingMetadata, type OwnershipRoutingResolution } from "@/lib/issues/ownership/routing-metadata";
import type { IssueAlertRule, IssueAlertSignal } from "@/lib/issues/issue-alerts/types";
import {
  buildIssueAlertWorkflowEventWrite,
  buildIssueAlertWorkflowPayload,
  enqueueIssueAlertWorkflowEventWithWriter,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  type IssueAlertWorkflowEventWrite,
} from "./contract";

function createSignal(): IssueAlertSignal {
  return {
    tenancyId: "tenancy-1",
    projectId: "project-1",
    branchId: "main",
    issue: {
      id: "issue-1",
      shortId: "PROJECT-1",
      type: "TypeError",
      value: "Token=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.signature and failure",
      culprit: "src/app.ts",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    },
    occurrence: { id: "occurrence-1", occurredAt: new Date("2026-08-06T12:00:00.000Z") },
    environment: "production",
    release: "web@2026.08.06",
    tags: new Map([["tier", "critical"]]),
    attributes: new Map<string, string | number>([
      ["authorization", "Bearer should-not-persist"],
      ["http.status_code", 500],
    ]),
    frequencyCounts: new Map([[300, 12]]),
  };
}

function createRule(actionOverrides: {
  subject?: string,
  html?: string,
} = {}): IssueAlertRule {
  return {
    schemaVersion: 1,
    id: "notify-on-errors",
    version: 1,
    enabled: true,
    conditions: { all: [{ type: "new", value: true }] },
    cooldown: { durationSeconds: 900, keyBy: "issue" },
    action: {
      type: "email",
      userIds: ["user-1"],
      subject: actionOverrides.subject ?? "Issue alert",
      html: actionOverrides.html ?? "<p>Inspect the issue in the dashboard.</p>",
      notificationCategoryName: "observability",
    },
  };
}

function createMatch(actionOverrides: {
  subject?: string,
  html?: string,
} = {}) {
  const result = evaluateIssueAlertRule(createRule(actionOverrides), createSignal());
  if (result.outcome !== "match") throw new Error("Test fixture must produce a matching issue alert");
  return result;
}

function createOwnerRoutingResolution(overrides: {
  members?: OwnershipRoutingResolution["recipients"],
  fallthrough?: "active_members" | "all_members" | "none",
} = {}): OwnershipRoutingResolution {
  const fallthrough = overrides.fallthrough ?? "active_members";
  const resolution = resolveOwnershipRecipients({
    schemaVersion: 1,
    scope: { tenancyId: "tenancy-1", projectId: "project-1", branchId: "main" },
    target: { type: "issue_owners", fallthrough },
    members: (overrides.members ?? [{ userId: "user-owner" }]).map((member) => ({
      scope: { tenancyId: "tenancy-1", projectId: "project-1", branchId: "main" },
      userId: member.userId,
      isActive: true,
      lastActiveAt: "2026-08-06T12:00:00.000Z",
    })),
    teams: [],
    issueOwners: (overrides.members === undefined ? [{
      scope: { tenancyId: "tenancy-1", projectId: "project-1", branchId: "main" },
      type: "user",
      userId: "user-owner",
      source: "ownership_rule",
    }] : []),
  });
  return {
    recipients: resolution.recipients,
    metadata: buildOwnershipRoutingMetadata({ type: "issue_owners", fallthrough }, resolution),
  };
}

describe("issue alert workflow event contract", () => {
  it("creates a bounded, scrubbed payload without copying evaluator attributes", () => {
    const result = buildIssueAlertWorkflowPayload(createMatch());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.byteLength).toBeLessThanOrEqual(32 * 1024);
      expect(result.payload.action).toEqual({
        type: "email",
        user_ids: ["user-1"],
        subject: "Issue alert",
        html: "<p>Inspect the issue in the dashboard.</p>",
        notification_category_name: "observability",
      });
      expect(result.payload).not.toHaveProperty("attributes");
      expect(result.payload).not.toHaveProperty("tags");
      expect(result.payload.summary).not.toContain("eyJ");
      expect(result.payload.summary).toContain("[Filtered]");
    }
  });

  it("carries owner-team emails next to explicit recipient ids", () => {
    const result = buildIssueAlertWorkflowPayload(createMatch(), undefined, ["ops@example.com"]);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.payload.action).toMatchObject({
        type: "email",
        user_ids: ["user-1"],
        emails: ["ops@example.com"],
      });
    }
  });

  it("drops owner-team emails that do not match the explicit recipient list", () => {
    const result = buildIssueAlertWorkflowPayload(createMatch(), undefined, ["ops@example.com", "second@example.com"]);
    expect(result.status).toBe("drop");
    if (result.status === "drop") {
      expect(result.reason).toBe("invalid_payload");
    }
  });

  it("interpolates issue placeholders into the email after privacy scrubbing", () => {
    const result = buildIssueAlertWorkflowPayload(createMatch({
      subject: "[{{kind}}] {{short_id}}: {{summary}}",
      html: "<p>{{type}} {{short_id}}</p><p>{{summary}}</p><a href=\"{{issue_url}}\">open</a>{{unknown}}",
    }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a rendered issue-alert payload");
    if (result.payload.action.type !== "email") throw new Error("Expected an email action");
    expect(result.payload.action.subject).toContain("[New issue] PROJECT-1:");
    expect(result.payload.action.subject).toContain("[Filtered]");
    expect(result.payload.action.subject).not.toContain("eyJ");
    expect(result.payload.action.html).toContain("TypeError PROJECT-1");
    expect(result.payload.action.html).toContain("[Filtered]");
    expect(result.payload.action.html).not.toContain("eyJ");
    expect(result.payload.action.html).toContain("{{unknown}}");
    expect(result.payload.action.html).not.toContain("{{issue_url}}");
    expect(result.payload.action.html).not.toContain("{{summary}}");
  });

  it("drops signals with control characters so a rendered subject can never span mail header lines", () => {
    const result = evaluateIssueAlertRule(createRule(), (() => {
      const signal = createSignal();
      signal.issue.value = "boom\r\nX-Injected: 1";
      return signal;
    })());

    expect(result.outcome).toBe("drop");
    if (result.outcome === "drop") expect(result.reason).toBe("invalid_signal");
  });

  it("rejects a tenancy mismatch before writing a workflow event", () => {
    const result = buildIssueAlertWorkflowEventWrite({ id: "other-tenancy" }, createMatch());
    expect(result).toEqual({ status: "drop", reason: "invalid_tenancy", byteLength: 0, scrubbed: false });
  });

  it("uses the existing workflow outbox writer and deterministic event id", async () => {
    const writes: IssueAlertWorkflowEventWrite[] = [];
    const result = await enqueueIssueAlertWorkflowEventWithWriter(
      { id: "tenancy-1" },
      createMatch(),
      async (options) => {
        writes.push(options);
        return { eventId: options.eventId };
      },
    );

    expect(result.status).toBe("enqueued");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(write.type).toBe(ISSUE_ALERT_WORKFLOW_EVENT_TYPE);
    expect(write.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    if (write.payload.action.type !== "email") throw new Error("Expected an email workflow action");
    expect(write.payload.action.user_ids).toEqual(["user-1"]);
  });

  it("drops webhook destinations at evaluation until an executor exists", () => {
    const rule: IssueAlertRule = {
      schemaVersion: 1,
      id: "notify-on-errors-webhook",
      version: 1,
      enabled: true,
      conditions: { all: [{ type: "new", value: true }] },
      cooldown: { durationSeconds: 900, keyBy: "issue" },
      action: { type: "webhook", integrationId: "integration-prod-errors" },
    };
    const evaluation = evaluateIssueAlertRule(rule, createSignal());
    expect(evaluation).toMatchObject({ outcome: "drop", reason: "unsupported_action" });
  });

  it("projects resolved owner routing into bounded recipients and explainable metadata", () => {
    const rule: IssueAlertRule = {
      schemaVersion: 1,
      id: "notify-on-error-owners",
      version: 1,
      enabled: true,
      conditions: { all: [{ type: "new", value: true }] },
      cooldown: { durationSeconds: 900, keyBy: "issue" },
      action: {
        type: "email",
        routing: { type: "issue_owners", fallthrough: "active_members" },
        subject: "Issue owner alert",
        html: "<p>Inspect the owner-routed issue.</p>",
      },
    };
    const evaluation = evaluateIssueAlertRule(rule, createSignal());
    if (evaluation.outcome !== "match") throw new Error("Test fixture must produce a matching issue alert");
    const routingResolution = createOwnerRoutingResolution();
    const result = buildIssueAlertWorkflowPayload(evaluation, routingResolution);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.payload.action).toMatchObject({
        type: "email",
        user_ids: ["user-owner"],
        routing_resolution: {
          schema_version: 1,
          target: { type: "issue_owners", fallthrough: "active_members" },
          status: "resolved",
          reason: "target_resolved",
          recipient_count: 1,
        },
        subject: "Issue owner alert",
        html: "<p>Inspect the owner-routed issue.</p>",
      });
      expect(result.payload.action).not.toHaveProperty("routing");
    }
  });

  it("carries an empty resolution without recipients so the workflow can drop it non-retriably", () => {
    const rule: IssueAlertRule = {
      schemaVersion: 1,
      id: "notify-on-empty-owners",
      version: 1,
      enabled: true,
      conditions: { all: [{ type: "new", value: true }] },
      cooldown: { durationSeconds: 900, keyBy: "issue" },
      action: {
        type: "email",
        routing: { type: "issue_owners", fallthrough: "none" },
        subject: "Issue owner alert",
        html: "<p>Inspect the owner-routed issue.</p>",
      },
    };
    const evaluation = evaluateIssueAlertRule(rule, createSignal());
    if (evaluation.outcome !== "match") throw new Error("Test fixture must produce a matching issue alert");
    const result = buildIssueAlertWorkflowPayload(evaluation, createOwnerRoutingResolution({ members: [], fallthrough: "none" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.payload.action.type === "email") {
      expect(result.payload.action.user_ids).toEqual([]);
      expect(result.payload.action.routing_resolution?.status).toBe("empty");
    }
  });

  it("requires the ingestion boundary to resolve owner routing before writing a workflow event", () => {
    const rule: IssueAlertRule = {
      schemaVersion: 1,
      id: "notify-on-unresolved-owners",
      version: 1,
      enabled: true,
      conditions: { all: [{ type: "new", value: true }] },
      cooldown: { durationSeconds: 900, keyBy: "issue" },
      action: {
        type: "email",
        routing: { type: "issue_owners", fallthrough: "none" },
        subject: "Issue owner alert",
        html: "<p>Inspect the owner-routed issue.</p>",
      },
    };
    const evaluation = evaluateIssueAlertRule(rule, createSignal());
    if (evaluation.outcome !== "match") throw new Error("Test fixture must produce a matching issue alert");
    expect(buildIssueAlertWorkflowPayload(evaluation)).toEqual({
      status: "drop",
      reason: "ownership_resolution_required",
      byteLength: 0,
      scrubbed: false,
    });
  });

  it("rejects inconsistent routing metadata instead of persisting explainability for another route", () => {
    const rule: IssueAlertRule = {
      schemaVersion: 1,
      id: "notify-on-mismatched-owners",
      version: 1,
      enabled: true,
      conditions: { all: [{ type: "new", value: true }] },
      cooldown: { durationSeconds: 900, keyBy: "issue" },
      action: {
        type: "email",
        routing: { type: "issue_owners", fallthrough: "active_members" },
        subject: "Issue owner alert",
        html: "<p>Inspect the owner-routed issue.</p>",
      },
    };
    const evaluation = evaluateIssueAlertRule(rule, createSignal());
    if (evaluation.outcome !== "match") throw new Error("Test fixture must produce a matching issue alert");
    const resolution = createOwnerRoutingResolution();
    const result = buildIssueAlertWorkflowPayload(evaluation, {
      ...resolution,
      metadata: {
        ...resolution.metadata,
        target: { type: "issue_owners", fallthrough: "none" },
      },
    });
    expect(result).toEqual({
      status: "drop",
      reason: "invalid_payload",
      byteLength: expect.any(Number),
      scrubbed: expect.any(Boolean),
    });
  });
});
