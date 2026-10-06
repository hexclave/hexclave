import { Prisma } from "@/generated/prisma/client";
import { MAX_ERROR_ATTACHMENTS_PER_EVENT } from "@/lib/attachments/attachment-contract";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import type { IssueAttachment } from "@hexclave/shared/dist/interface/admin-issues";
import { scrubPublicText } from "./public-scrub";

type PublicAttachmentRow = {
  id: string,
  eventId: string,
  occurrenceId: string | null,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256: string,
  createdAt: Date,
};

export async function loadPublicIssueAttachments(
  tenancy: Tenancy,
  eventIds: readonly string[],
): Promise<Map<string, IssueAttachment[]>> {
  const uniqueEventIds = [...new Set(eventIds)];
  const attachmentsByEvent = new Map<string, IssueAttachment[]>(uniqueEventIds.map((eventId) => [eventId, []]));
  if (uniqueEventIds.length === 0) return attachmentsByEvent;

  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$replica().$queryRaw<PublicAttachmentRow[]>(Prisma.sql`
    SELECT "id", "eventId", "occurrenceId", "filename", "contentType", "attachmentType",
           "byteLength", "sha256", "createdAt"
    FROM (
      SELECT
        "id", "eventId", "occurrenceId", "filename", "contentType", "attachmentType",
        "byteLength", "sha256", "createdAt",
        row_number() OVER (PARTITION BY "eventId" ORDER BY "createdAt" DESC, "id" DESC) AS "rowNumber"
      FROM "ErrorAttachment"
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "projectId" = ${tenancy.project.id}
        AND "branchId" = ${tenancy.branchId}
        AND "eventId" IN (${Prisma.join(uniqueEventIds)})
    ) AS scoped_attachments
    WHERE "rowNumber" <= ${MAX_ERROR_ATTACHMENTS_PER_EVENT}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ${Math.min(uniqueEventIds.length * MAX_ERROR_ATTACHMENTS_PER_EVENT, 5_000)}
  `);
  for (const row of rows) {
    const attachments = attachmentsByEvent.get(row.eventId);
    if (attachments === undefined || attachments.length >= MAX_ERROR_ATTACHMENTS_PER_EVENT) continue;
    attachments.push({
      id: row.id,
      event_id: row.eventId,
      occurrence_id: row.occurrenceId,
      filename: scrubPublicText(row.filename),
      content_type: scrubPublicText(row.contentType),
      attachment_type: scrubPublicText(row.attachmentType),
      byte_length: row.byteLength,
      sha256: row.sha256,
      download_path: `/api/latest/analytics/attachments/${encodeURIComponent(row.id)}`,
      created_at: row.createdAt.toISOString(),
    });
  }
  return attachmentsByEvent;
}
