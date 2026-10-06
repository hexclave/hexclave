import {
  toPublicIssue,
  type PublicIssue,
  type PublicIssueOccurrence,
} from "@/app/api/latest/issues/contract";
import { Prisma } from "@/generated/prisma/client";
import { getErrorAttachmentEventId } from "@/lib/attachments/attachment-event-id";
import { loadIssueReleaseContext } from "@/lib/releases/issue-release-context";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import type { IssueListItem, IssueProductMetadata } from "@hexclave/shared/dist/interface/admin-issues";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { resolveIssueIdentity } from "./issue-identity";
import { serializeIssueProductSnapshot } from "./issue-product-projection";
import { loadIssueProductSnapshot } from "./issue-product";
import {
  deriveSubstatus,
  effectiveStatus,
  issueRangeStart,
  loadIssueWindowStats,
  loadOccurrence,
  type OccurrenceCursor,
} from "./issue-queries";
import { loadPublicIssueAttachments } from "./occurrence-attachments";
import {
  projectPublicIssueOccurrence,
  resolveOccurrenceReplayIds,
} from "./occurrence-projection";


export type IssueDetailRow = {
  id: string,
  shortId: bigint,
  type: string,
  value: string,
  culprit: string,
  status: "UNRESOLVED" | "RESOLVED" | "IGNORED",
  firstSeenAt: Date,
  lastSeenAt: Date,
  regressedAt: Date | null,
  timesSeen: bigint,
  countersTruncatedAt: Date | null,
  ignoredUntil: Date | null,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  firstSeenRelease: string | null,
  lastSeenRelease: string | null,
  updatedAt: Date,
  handled: boolean,
  synthetic: boolean,
  hashes: string[],
};

export type IssueDetailContext = {
  row: IssueDetailRow,
  hashes: string[],
  redirectedFromIssueId: string | null,
};

export async function loadIssueDetailContext(
  tenancy: Tenancy,
  rawId: string,
): Promise<IssueDetailContext | null> {
  const identity = await resolveIssueIdentity(tenancy, rawId);
  if (identity === null) return null;

  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$replica().$queryRaw<IssueDetailRow[]>(Prisma.sql`
    SELECT
      i."id", i."shortId", i."type", i."value", i."culprit", i."status"::text AS "status",
      i."firstSeenAt", i."lastSeenAt", i."regressedAt", i."timesSeen",
      i."countersTruncatedAt", i."ignoredUntil",
      i."serviceName", i."deploymentEnvironmentName", i."firstSeenRelease", i."lastSeenRelease", i."updatedAt",
      i."handled", i."synthetic",
      COALESCE(
        (SELECT array_agg(h."hash") FROM "IssueHash" h
         WHERE h."tenancyId" = i."tenancyId" AND h."issueId" = i."id"),
        ARRAY[]::text[]
      ) AS "hashes"
    FROM "Issue" i
    WHERE i."tenancyId" = ${tenancy.id}::uuid
      AND i."id" = ${identity.issueId}::uuid
    LIMIT 1
  `);
  const row = rows.at(0);
  if (row === undefined) return null;
  return { row, hashes: row.hashes, redirectedFromIssueId: identity.redirectedFromIssueId };
}

export function projectIssueListItem(
  row: IssueDetailRow,
  options: {
    rangeStart: Date,
    now: Date,
    stats: { occurrences: number, users: number },
  },
): IssueListItem {
  return {
    id: row.id,
    short_id: row.shortId.toString(),
    type: row.type,
    value: row.value,
    culprit: row.culprit,
    level: "error",
    status: effectiveStatus(row, row.ignoredUntil, options.now),
    substatus: deriveSubstatus(row, options.rangeStart),
    first_seen_at_millis: row.firstSeenAt.getTime(),
    last_seen_at_millis: row.lastSeenAt.getTime(),
    times_seen: row.timesSeen.toString(),
    counters_truncated_at_millis: row.countersTruncatedAt?.getTime() ?? null,
    window_occurrences: options.stats.occurrences,
    window_users: options.stats.users,
    service_name: row.serviceName,
    environment: row.deploymentEnvironmentName,
    release: row.lastSeenRelease,
    handled: row.handled,
    synthetic: row.synthetic,
    updated_at_millis: row.updatedAt.getTime(),
    issue_hashes: row.hashes,
  };
}

async function loadPublicIssue(options: {
  tenancy: Tenancy,
  issueId: string,
  hours: number,
}): Promise<{
  issue: PublicIssue,
  hashes: string[],
  firstSeenRelease: string | null,
  lastSeenRelease: string | null,
} | null> {
  const context = await loadIssueDetailContext(options.tenancy, options.issueId);
  if (context === null) return null;

  const now = new Date();
  const rangeStart = issueRangeStart(options.hours, now);
  const stats = await loadIssueWindowStats({
    tenancy: options.tenancy,
    hashes: context.hashes,
    rangeStart,
  });
  return {
    issue: toPublicIssue(projectIssueListItem(context.row, { rangeStart, now, stats })),
    hashes: context.hashes,
    firstSeenRelease: context.row.firstSeenRelease,
    lastSeenRelease: context.row.lastSeenRelease,
  };
}

export async function loadPublicIssueDetail(options: {
  tenancy: Tenancy,
  issueId: string,
  hours: number,
  occurrence: OccurrenceCursor | null,
  direction: "older" | "newer",
}): Promise<{
  issue: PublicIssue,
  occurrence: PublicIssueOccurrence | null,
  product: IssueProductMetadata,
  release_context: Awaited<ReturnType<typeof loadIssueReleaseContext>>,
  newer_cursor: string | null,
  older_cursor: string | null,
} | null> {
  const resolved = await loadPublicIssue({
    tenancy: options.tenancy,
    issueId: options.issueId,
    hours: options.hours,
  });
  if (resolved === null) return null;

  const occurrence = await loadOccurrence({
    tenancy: options.tenancy,
    hashes: resolved.hashes,
    cursor: options.occurrence,
    direction: options.direction,
  });
  const resolvedOccurrence = occurrence.occurrence === null
    ? null
    : (await resolveOccurrenceReplayIds(options.tenancy, [occurrence.occurrence]))[0]
      ?? throwErr("resolveOccurrenceReplayIds returned an empty array for a single-row input");
  const attachmentEventId = resolvedOccurrence === null ? null : getErrorAttachmentEventId(resolvedOccurrence.occurrence_id);
  const attachmentsByEvent = await loadPublicIssueAttachments(
    options.tenancy,
    attachmentEventId === null ? [] : [attachmentEventId],
  );
  const product = serializeIssueProductSnapshot(await loadIssueProductSnapshot({
    tenancy: options.tenancy,
    issueId: resolved.issue.id,
  }));
  const releaseContext = await loadIssueReleaseContext({
    tenancy: options.tenancy,
    issueId: resolved.issue.id,
    firstSeenRelease: resolved.firstSeenRelease,
    lastSeenRelease: resolved.lastSeenRelease,
  });

  return {
    issue: resolved.issue,
    product,
    release_context: releaseContext,
    occurrence: resolvedOccurrence === null
      ? null
      : await projectPublicIssueOccurrence(resolvedOccurrence, {
        scope: {
          tenantId: options.tenancy.id,
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
        },
        attachments: attachmentEventId === null ? [] : attachmentsByEvent.get(attachmentEventId) ?? [],
      }),
    newer_cursor: occurrence.newerCursor,
    older_cursor: occurrence.olderCursor,
  };
}
