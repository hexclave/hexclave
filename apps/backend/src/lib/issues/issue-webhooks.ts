import { getPrismaClientForTenancy } from "@/prisma-client";
import { createHash } from "node:crypto";
import type { Tenancy } from "@/lib/tenancies";
import { isWebhooksAppEnabled, sendIssueCreatedWebhook, sendIssueIgnoredWebhook, sendIssueMergedWebhook, sendIssueRegressedWebhook, sendIssueResolvedWebhook } from "@/lib/webhooks";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { IssueStatus, IssueSubstatus } from "@hexclave/shared/dist/interface/admin-issues";
import type { IssueBatchApplyOutcome } from "./issue-store";


export const ISSUE_WEBHOOK_THROTTLE_MS = 5 * 60 * 1000;

/** Svix event ids are length- and charset-restricted; a digest keeps composite ids deterministic and valid. */
export function issueWebhookEventId(rawEventId: string): string {
  return `issue_${createHash("sha256").update(rawEventId).digest("hex")}`;
}

type IssueStatusColumn = "UNRESOLVED" | "RESOLVED" | "IGNORED";

const WEBHOOK_STATUS_BY_COLUMN: Record<IssueStatusColumn, IssueStatus> = {
  UNRESOLVED: "unresolved",
  RESOLVED: "resolved",
  IGNORED: "ignored",
};

type IssueWebhookRow = {
  id: string,
  shortId: bigint,
  type: string,
  value: string,
  culprit: string,
  status: IssueStatusColumn,
  firstSeenAt: Date,
  lastSeenAt: Date,
  timesSeen: bigint,
  regressedAt: Date | null,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  lastSeenRelease: string | null,
};

function buildIssueWebhookData(tenancy: Tenancy, row: IssueWebhookRow, substatus: IssueSubstatus) {
  const dashboardUrl = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "");
  return {
    id: row.id,
    short_id: row.shortId.toString(),
    times_seen: row.timesSeen.toString(),
    type: row.type,
    value: row.value,
    culprit: row.culprit,
    level: "error",
    status: WEBHOOK_STATUS_BY_COLUMN[row.status],
    substatus,
    first_seen_at_millis: row.firstSeenAt.getTime(),
    last_seen_at_millis: row.lastSeenAt.getTime(),
    service_name: row.serviceName,
    environment: row.deploymentEnvironmentName,
    release: row.lastSeenRelease,
    url: dashboardUrl === ""
      ? ""
      : urlString`${dashboardUrl}/projects/${tenancy.project.id}/observability/issues/${row.id}`,
  };
}

async function claimWebhookSlots(
  tenancy: Tenancy,
  issueIds: readonly string[],
  createdIssueIds: ReadonlySet<string>,
  now: Date,
  force: boolean,
): Promise<Map<string, IssueWebhookRow>> {
  if (issueIds.length === 0) return new Map();
  const prisma = await getPrismaClientForTenancy(tenancy);

  const rows = await prisma.$queryRaw<IssueWebhookRow[]>`
    UPDATE "Issue"
    SET "lastWebhookAt" = CASE
        WHEN "id" = ANY(${[...createdIssueIds]}::uuid[]) THEN "lastWebhookAt"
        ELSE ${now}::timestamptz
      END
    WHERE "tenancyId" = ${tenancy.id}::uuid
      AND "id" = ANY(${issueIds}::uuid[])
      AND (
        ${force}
        OR "lastWebhookAt" IS NULL
        OR "lastWebhookAt" < ${new Date(now.getTime() - ISSUE_WEBHOOK_THROTTLE_MS)}::timestamptz
      )
    RETURNING "id", "shortId", "type", "value", "culprit", "status"::text AS "status",
              "firstSeenAt", "lastSeenAt", "timesSeen", "regressedAt",
              "serviceName", "deploymentEnvironmentName", "lastSeenRelease"
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

export async function emitIssueWebhooks(options: {
  tenancy: Tenancy,
  outcomes: readonly IssueBatchApplyOutcome[],
  now: Date,
  batchId?: string,
  force?: boolean,
}): Promise<void> {
  const { tenancy, outcomes, now, batchId, force = false } = options;
  if (outcomes.length === 0) return;
  if (!isWebhooksAppEnabled(tenancy)) return;

  const notable = outcomes.filter((outcome) => outcome.isNew || outcome.isRegression);
  if (notable.length === 0) return;

  const claimed = await claimWebhookSlots(
    tenancy,
    notable.map((outcome) => outcome.issueId),
    new Set(notable.filter((outcome) => outcome.isNew).map((outcome) => outcome.issueId)),
    now,
    force,
  );
  if (claimed.size === 0) return;

  await Promise.all(notable.flatMap((outcome) => {
    const row = claimed.get(outcome.issueId);
    if (row === undefined) return [];

    if (outcome.isNew) {
      return [sendIssueCreatedWebhook({
        projectId: tenancy.project.id,
        data: buildIssueWebhookData(tenancy, row, "new"),
        eventId: row.id,
      })];
    }

    return [sendIssueRegressedWebhook({
      projectId: tenancy.project.id,
      data: buildIssueWebhookData(tenancy, row, "regressed"),
      eventId: issueWebhookEventId(batchId === undefined
        ? `${row.id}:${(row.regressedAt ?? now).getTime()}`
        : `${row.id}:${batchId}:regression`),
    })];
  }));
}

export async function emitIssueLifecycleWebhook(options: {
  tenancy: Tenancy,
  issueId: string,
  event: "resolved" | "ignored" | "merged",
  now: Date,
  eventId?: string,
}): Promise<void> {
  const { tenancy, issueId, event, now } = options;
  if (!isWebhooksAppEnabled(tenancy)) return;

  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$queryRaw<IssueWebhookRow[]>`
    SELECT "id", "shortId", "type", "value", "culprit", "status"::text AS "status",
           "firstSeenAt", "lastSeenAt", "timesSeen", "regressedAt",
           "serviceName", "deploymentEnvironmentName", "lastSeenRelease"
    FROM "Issue"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "id" = ${issueId}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) return;
  const row = rows[0];

  const data = {
    ...buildIssueWebhookData(tenancy, row, "ongoing"),
    ...event === "merged" ? {} : { status: event },
  };
  const eventId = issueWebhookEventId(options.eventId ?? `${row.id}:${event}:${now.getTime()}`);

  switch (event) {
    case "resolved": {
      await sendIssueResolvedWebhook({ projectId: tenancy.project.id, data, eventId });
      return;
    }
    case "ignored": {
      await sendIssueIgnoredWebhook({ projectId: tenancy.project.id, data, eventId });
      return;
    }
    case "merged": {
      await sendIssueMergedWebhook({ projectId: tenancy.project.id, data, eventId });
      return;
    }
  }
}
