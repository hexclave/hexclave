import { Prisma } from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { toJsonInput } from "./agent-writes";
import { compileGrowthDocument } from "./content-document";
import { growthFindingToWire } from "./overview";


function sourceToWire(value: unknown): unknown | null {
  return value ?? null;
}

async function findFinding(tenancy: Tenancy, findingId: string) {
  const finding = await globalPrismaClient.growthFinding.findFirst({
    where: { id: findingId, projectId: tenancy.project.id, branchId: tenancy.branchId },
  });
  if (finding == null) throw new StatusError(404, "Growth evidence not found.");
  return finding;
}

export async function getGrowthAdminFindingPage(tenancy: Tenancy, findingId: string) {
  const finding = await findFinding(tenancy, findingId);
  return {
    finding: growthFindingToWire(finding),
    draft: finding.documentDraft == null || finding.documentDraftUpdatedAt == null ? null : {
      source_json: sourceToWire(finding.documentDraftSourceJson),
      document: finding.documentDraft,
      updated_at_millis: finding.documentDraftUpdatedAt.getTime(),
    },
    published_at_millis: finding.documentPublishedAt?.getTime() ?? null,
  };
}

export async function saveGrowthAdminFindingPageDraft(tenancy: Tenancy, findingId: string, input: {
  document: unknown,
  expectedDraftUpdatedAtMillis: number | null,
}) {
  const compiled = compileGrowthDocument(input.document);
  const finding = await findFinding(tenancy, findingId);
  const storedDraftMillis = finding.documentDraftUpdatedAt?.getTime() ?? null;
  if (storedDraftMillis !== input.expectedDraftUpdatedAtMillis) {
    throw new StatusError(409, "Someone else saved this evidence page after you opened it. Reload the page before saving.");
  }

  const draftUpdatedAt = new Date();
  const updated = await globalPrismaClient.growthFinding.updateMany({
    where: {
      id: finding.id,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      documentDraftUpdatedAt: finding.documentDraftUpdatedAt,
    },
    data: {
      documentDraftSourceJson: toJsonInput(input.document),
      documentDraft: toJsonInput(compiled),
      documentDraftUpdatedAt: draftUpdatedAt,
    },
  });
  if (updated.count === 0) {
    throw new StatusError(409, "Someone else saved this evidence page after you opened it. Reload the page before saving.");
  }
  return {
    source_json: input.document,
    document: compiled,
    updated_at_millis: draftUpdatedAt.getTime(),
  };
}

export async function publishGrowthAdminFindingPageDraft(tenancy: Tenancy, findingId: string, input: {
  expectedDraftUpdatedAtMillis: number,
  publishedByUserId: string,
}) {
  const finding = await findFinding(tenancy, findingId);
  if (finding.documentDraft == null || finding.documentDraftUpdatedAt == null) {
    throw new StatusError(400, "Save an evidence-page draft before publishing.");
  }
  if (finding.documentDraftUpdatedAt.getTime() !== input.expectedDraftUpdatedAtMillis) {
    throw new StatusError(409, "This evidence-page draft changed after you opened it. Reload it before publishing.");
  }

  const documentPublishedAt = new Date();
  const updated = await globalPrismaClient.growthFinding.updateMany({
    where: { id: finding.id, documentDraftUpdatedAt: finding.documentDraftUpdatedAt },
    data: {
      document: toJsonInput(finding.documentDraft),
      documentPublishedAt,
      documentPublishedByUserId: input.publishedByUserId,
      documentDraftSourceJson: Prisma.DbNull,
      documentDraft: Prisma.DbNull,
      documentDraftUpdatedAt: null,
    },
  });
  if (updated.count === 0) {
    throw new StatusError(409, "This evidence-page draft changed while it was being published. Reload it and try again.");
  }
  return { status: "published", published_at_millis: documentPublishedAt.getTime() };
}

export async function discardGrowthAdminFindingPageDraft(tenancy: Tenancy, findingId: string) {
  const finding = await findFinding(tenancy, findingId);
  if (finding.documentDraftUpdatedAt == null) throw new StatusError(404, "This evidence page has no draft to discard.");
  const updated = await globalPrismaClient.growthFinding.updateMany({
    where: { id: finding.id, documentDraftUpdatedAt: finding.documentDraftUpdatedAt },
    data: {
      documentDraftSourceJson: Prisma.DbNull,
      documentDraft: Prisma.DbNull,
      documentDraftUpdatedAt: null,
    },
  });
  if (updated.count === 0) {
    throw new StatusError(409, "This evidence-page draft changed while it was being discarded. Reload it and try again.");
  }
  return { status: "deleted" };
}
