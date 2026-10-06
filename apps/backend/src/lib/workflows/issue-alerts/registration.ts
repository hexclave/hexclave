import { globalPrismaClient } from "@/prisma-client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { syncWorkflowSource } from "@/lib/workflows/api";
import type { WorkflowSyncResultJson } from "@hexclave/shared/dist/interface/workflows";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createHash } from "node:crypto";
import {
  ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
} from "./contract";
import {
  ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
  validateIssueAlertWorkflowSource,
} from "./source";

const ISSUE_ALERT_EMAIL_WORKFLOW_DISPLAY_NAME = "Issue alert email";
const MAX_REGISTRATION_ATTEMPTS = 3;

export type IssueAlertWorkflowLatestSource = {
  version: number,
  source: string,
};

export type IssueAlertWorkflowSyncOptions = {
  workflowId: string,
  source: string,
  displayName?: string,
  mustBeNew: boolean,
  expectedLatestVersion?: number | null,
};

export type IssueAlertWorkflowRegistrationDependencies = {
  readLatest: (tenancyId: string, workflowId: string) => Promise<IssueAlertWorkflowLatestSource | null>,
  sync: (tenancy: Pick<Tenancy, "id">, options: IssueAlertWorkflowSyncOptions) => Promise<WorkflowSyncResultJson>,
};

export type IssueAlertWorkflowRegistrationResult = WorkflowSyncResultJson & {
  status: "created" | "unchanged",
  trigger_event_type: typeof ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  delivery_boundary: "ServerApp.sendEmail",
  durable_email_store: "EmailOutbox",
  terminal_failure_state: "dropped",
};

async function readLatestWorkflowSource(tenancyId: string, workflowId: string): Promise<IssueAlertWorkflowLatestSource | null> {
  const definition = await globalPrismaClient.workflowDefinition.findUnique({
    where: { tenancyId_workflowId: { tenancyId, workflowId } },
    select: { latestVersion: true },
  });
  if (definition === null) return null;
  const version = await globalPrismaClient.workflowVersion.findUnique({
    where: { tenancyId_workflowId_version: { tenancyId, workflowId, version: definition.latestVersion } },
    select: { source: true },
  }) ?? throwErr("WorkflowDefinition.latestVersion points at a missing version row");
  return { version: definition.latestVersion, source: version.source };
}

async function syncThroughPublicWorkflowApi(
  tenancy: Pick<Tenancy, "id">,
  options: IssueAlertWorkflowSyncOptions,
): Promise<WorkflowSyncResultJson> {
  const loaded = await getTenancy(tenancy.id);
  if (loaded == null) {
    throw new HexclaveAssertionError("Cannot register the issue-alert workflow because the tenancy no longer exists", {
      tenancyId: tenancy.id,
    });
  }
  return await syncWorkflowSource(loaded, options);
}

const productionDependencies: IssueAlertWorkflowRegistrationDependencies = {
  readLatest: readLatestWorkflowSource,
  sync: syncThroughPublicWorkflowApi,
};

function assertBuiltInSourceIsSafe(): void {
  const validation = validateIssueAlertWorkflowSource(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE);
  if (validation.status === "error") {
    throw new HexclaveAssertionError("The built-in issue-alert workflow source failed its email-boundary validation", {
      reason: validation.reason,
    });
  }
}

function isExpectedRegistrationRace(error: unknown): boolean {
  if (!StatusError.isStatusError(error)) return false;
  if (error.statusCode === 409) return true;
  if (error.statusCode === 400 && error.message === `A workflow with id "${ISSUE_ALERT_EMAIL_WORKFLOW_ID}" already exists`) return true;
  return error.statusCode === 404 && error.message === `Workflow "${ISSUE_ALERT_EMAIL_WORKFLOW_ID}" not found`;
}

const KNOWN_BUILT_IN_SOURCE_HASHES = new Set([
  createHash("sha256").update(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).digest("hex"),
]);

function canReplaceInstalledSource(source: string): boolean {
  return KNOWN_BUILT_IN_SOURCE_HASHES.has(createHash("sha256").update(source).digest("hex"));
}

function throwWorkflowIdCollision(current: IssueAlertWorkflowLatestSource): never {
  throw new StatusError(
    StatusError.Conflict,
    `Cannot register built-in workflow "${ISSUE_ALERT_EMAIL_WORKFLOW_ID}": the id is already occupied by a different source (latest version ${current.version}). Refusing to overwrite it`,
  );
}

export async function ensureIssueAlertEmailWorkflow(
  tenancy: Pick<Tenancy, "id">,
  dependencies: IssueAlertWorkflowRegistrationDependencies = productionDependencies,
): Promise<IssueAlertWorkflowRegistrationResult> {
  assertBuiltInSourceIsSafe();

  for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt++) {
    const current = await dependencies.readLatest(tenancy.id, ISSUE_ALERT_EMAIL_WORKFLOW_ID);
    if (current !== null && !canReplaceInstalledSource(current.source)) {
      return throwWorkflowIdCollision(current);
    }

    const syncOptions: IssueAlertWorkflowSyncOptions = {
      workflowId: ISSUE_ALERT_EMAIL_WORKFLOW_ID,
      source: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
      displayName: ISSUE_ALERT_EMAIL_WORKFLOW_DISPLAY_NAME,
      mustBeNew: current === null,
      expectedLatestVersion: current?.version ?? null,
    };

    try {
      const syncResult = await dependencies.sync(tenancy, syncOptions);
      const latest = await dependencies.readLatest(tenancy.id, ISSUE_ALERT_EMAIL_WORKFLOW_ID);
      if (latest === null || latest.source !== ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE || latest.version !== syncResult.version) {
        throw new HexclaveAssertionError("Issue-alert workflow registration returned without making the expected built-in version available", {
          tenancyId: tenancy.id,
          expectedVersion: syncResult.version,
          actualVersion: latest?.version,
        });
      }
      return {
        ...syncResult,
        status: syncResult.created ? "created" : "unchanged",
        trigger_event_type: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
        delivery_boundary: "ServerApp.sendEmail",
        durable_email_store: "EmailOutbox",
        terminal_failure_state: "dropped",
      };
    } catch (error) {
      if (!isExpectedRegistrationRace(error)) throw error;
      const raced = await dependencies.readLatest(tenancy.id, ISSUE_ALERT_EMAIL_WORKFLOW_ID);
      if (raced !== null && !canReplaceInstalledSource(raced.source)) {
        return throwWorkflowIdCollision(raced);
      }
      if (attempt + 1 === MAX_REGISTRATION_ATTEMPTS) {
        throw new StatusError(StatusError.Conflict, `Could not register built-in workflow "${ISSUE_ALERT_EMAIL_WORKFLOW_ID}" after concurrent changes; retry the registration`);
      }
    }
  }

  throw new StatusError(StatusError.Conflict, `Could not register built-in workflow "${ISSUE_ALERT_EMAIL_WORKFLOW_ID}"; retry the registration`);
}
