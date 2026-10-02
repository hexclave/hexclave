import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { WorkflowSyncResultJson } from "@hexclave/shared/dist/interface/workflows";
import { describe, expect, it } from "vitest";
import {
  ensureIssueAlertEmailWorkflow,
  type IssueAlertWorkflowLatestSource,
  type IssueAlertWorkflowRegistrationDependencies,
  type IssueAlertWorkflowSyncOptions,
} from "./registration";
import {
  ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
} from "./contract";
import { ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE } from "./source";

const tenancy = { id: "tenancy-1" } satisfies Pick<Tenancy, "id">;

function syncResult(created: boolean, version: number): WorkflowSyncResultJson {
  return {
    workflow_id: ISSUE_ALERT_EMAIL_WORKFLOW_ID,
    version,
    created,
    in_flight_runs_on_older_versions: 0,
  };
}

function dependencies(options: {
  readLatest: () => Promise<IssueAlertWorkflowLatestSource | null>,
  sync: IssueAlertWorkflowRegistrationDependencies["sync"],
}): IssueAlertWorkflowRegistrationDependencies {
  return {
    readLatest: options.readLatest,
    sync: options.sync,
  };
}

describe("ensureIssueAlertEmailWorkflow", () => {
  it("creates the built-in source through the existing workflow sync API", async () => {
    let current: IssueAlertWorkflowLatestSource | null = null;
    const calls: IssueAlertWorkflowSyncOptions[] = [];
    const result = await ensureIssueAlertEmailWorkflow(tenancy, dependencies({
      readLatest: async () => current,
      sync: async (_, options) => {
        calls.push(options);
        current = { version: 1, source: options.source };
        return syncResult(true, 1);
      },
    }));

    expect(result).toMatchObject({
      status: "created",
      workflow_id: ISSUE_ALERT_EMAIL_WORKFLOW_ID,
      version: 1,
      trigger_event_type: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
      delivery_boundary: "ServerApp.sendEmail",
      durable_email_store: "EmailOutbox",
      terminal_failure_state: "dropped",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workflowId: ISSUE_ALERT_EMAIL_WORKFLOW_ID,
      source: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
      displayName: "Issue alert email",
      mustBeNew: true,
      expectedLatestVersion: null,
    });
  });

  it("is idempotent for an already-installed built-in version", async () => {
    const current = { version: 4, source: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE };
    let syncCalls = 0;
    const result = await ensureIssueAlertEmailWorkflow(tenancy, dependencies({
      readLatest: async () => current,
      sync: async (_, options) => {
        syncCalls++;
        expect(options.mustBeNew).toBe(false);
        return syncResult(false, current.version);
      },
    }));

    expect(result.status).toBe("unchanged");
    expect(result.version).toBe(current.version);
    expect(syncCalls).toBe(1);
  });

  it("refuses to overwrite a workflow id owned by another source", async () => {
    let syncCalls = 0;
    const dependenciesForCollision = dependencies({
      readLatest: async () => ({ version: 2, source: "export default workflow(\"issue-alert-email\")" }),
      sync: async () => {
        syncCalls++;
        return syncResult(false, 2);
      },
    });

    await expect(ensureIssueAlertEmailWorkflow(tenancy, dependenciesForCollision)).rejects.toMatchObject({
      name: "StatusError",
      statusCode: 409,
      message: expect.stringContaining("Refusing to overwrite"),
    });
    expect(syncCalls).toBe(0);
  });

  it("does not infer built-in ownership from email-boundary markers", async () => {
    const previousSource = 'customEvent("hexclave.issue-alert"); hexclaveApp.sendEmail({ userIds: event.data.action.user_ids });';
    let current: IssueAlertWorkflowLatestSource = { version: 3, source: previousSource };
    const calls: IssueAlertWorkflowSyncOptions[] = [];
    await expect(ensureIssueAlertEmailWorkflow(tenancy, dependencies({
      readLatest: async () => current,
      sync: async (_, options) => {
        calls.push(options);
        current = { version: 4, source: options.source };
        return syncResult(false, 4);
      },
    }))).rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toHaveLength(0);
  });

  it("retries a concurrent first install, then converges on the built-in version", async () => {
    let current: IssueAlertWorkflowLatestSource | null = null;
    let reads = 0;
    let syncCalls = 0;
    const result = await ensureIssueAlertEmailWorkflow(tenancy, {
      readLatest: async () => {
        reads++;
        return current;
      },
      sync: async (_, options) => {
        syncCalls++;
        if (syncCalls === 1) {
          current = { version: 1, source: options.source };
          throw new StatusError(StatusError.Conflict, "Workflow was created concurrently");
        }
        expect(options.mustBeNew).toBe(false);
        return syncResult(false, 1);
      },
    });

    expect(result.status).toBe("unchanged");
    expect(result.version).toBe(1);
    expect(syncCalls).toBe(2);
    expect(reads).toBe(4);
  });
});
