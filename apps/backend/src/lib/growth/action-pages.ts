import { Prisma } from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { growthActionItemToWire, loadGrowthActionWorkflowRuntimeInfo } from "./actions";
import { toJsonInput } from "./agent-writes";
import { compileGrowthActionDocument } from "./content-document";

/**
 * Staff authoring for a single action page.
 *
 * GrowthActionItem.document remains the customer-facing copy. Draft source and its compiled form
 * live in separate columns so saving/previewing can never leak unfinished text to a customer.
 */

function sourceToWire(value: unknown): unknown | null {
  return value ?? null;
}

async function findAction(tenancy: Tenancy, actionId: string) {
  const action = await globalPrismaClient.growthActionItem.findFirst({
    where: { id: actionId, projectId: tenancy.project.id, branchId: tenancy.branchId },
  });
  if (action == null) throw new StatusError(404, "Growth action not found.");
  return action;
}

export async function getGrowthAdminActionPage(tenancy: Tenancy, actionId: string) {
  const action = await findAction(tenancy, actionId);
  const runtime = await loadGrowthActionWorkflowRuntimeInfo(tenancy, [action]);
  return {
    action: growthActionItemToWire(action, runtime.get(action.id) ?? null),
    draft: action.documentDraft == null || action.documentDraftUpdatedAt == null ? null : {
      source_json: sourceToWire(action.documentDraftSourceJson),
      document: action.documentDraft,
      updated_at_millis: action.documentDraftUpdatedAt.getTime(),
    },
    published_at_millis: action.documentPublishedAt?.getTime() ?? null,
  };
}

export async function saveGrowthAdminActionPageDraft(tenancy: Tenancy, actionId: string, input: {
  document: unknown,
  expectedDraftUpdatedAtMillis: number | null,
}) {
  const compiled = compileGrowthActionDocument(input.document);
  const action = await findAction(tenancy, actionId);
  const storedDraftMillis = action.documentDraftUpdatedAt?.getTime() ?? null;
  if (storedDraftMillis !== input.expectedDraftUpdatedAtMillis) {
    throw new StatusError(409, "Someone else saved this action page after you opened it. Reload the page before saving.");
  }

  const draftUpdatedAt = new Date();
  const updated = await globalPrismaClient.growthActionItem.updateMany({
    where: {
      id: action.id,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      documentDraftUpdatedAt: action.documentDraftUpdatedAt,
    },
    data: {
      documentDraftSourceJson: toJsonInput(input.document),
      documentDraft: toJsonInput(compiled),
      documentDraftUpdatedAt: draftUpdatedAt,
    },
  });
  if (updated.count === 0) {
    throw new StatusError(409, "Someone else saved this action page after you opened it. Reload the page before saving.");
  }
  return {
    source_json: input.document,
    document: compiled,
    updated_at_millis: draftUpdatedAt.getTime(),
  };
}

export async function publishGrowthAdminActionPageDraft(tenancy: Tenancy, actionId: string, input: {
  expectedDraftUpdatedAtMillis: number,
  publishedByUserId: string,
}) {
  const action = await findAction(tenancy, actionId);
  if (action.documentDraft == null || action.documentDraftUpdatedAt == null) {
    throw new StatusError(400, "Save an action-page draft before publishing.");
  }
  if (action.documentDraftUpdatedAt.getTime() !== input.expectedDraftUpdatedAtMillis) {
    throw new StatusError(409, "This action-page draft changed after you opened it. Reload it before publishing.");
  }
  const documentPublishedAt = new Date();
  const updated = await globalPrismaClient.growthActionItem.updateMany({
    where: { id: action.id, documentDraftUpdatedAt: action.documentDraftUpdatedAt },
    data: {
      document: toJsonInput(action.documentDraft),
      documentPublishedAt,
      documentPublishedByUserId: input.publishedByUserId,
      documentDraftSourceJson: Prisma.DbNull,
      documentDraft: Prisma.DbNull,
      documentDraftUpdatedAt: null,
    },
  });
  if (updated.count === 0) {
    throw new StatusError(409, "This action-page draft changed while it was being published. Reload it and try again.");
  }
  return { status: "published", published_at_millis: documentPublishedAt.getTime() };
}

export async function discardGrowthAdminActionPageDraft(tenancy: Tenancy, actionId: string) {
  const action = await findAction(tenancy, actionId);
  if (action.documentDraftUpdatedAt == null) throw new StatusError(404, "This action page has no draft to discard.");
  const updated = await globalPrismaClient.growthActionItem.updateMany({
    where: { id: action.id, documentDraftUpdatedAt: action.documentDraftUpdatedAt },
    data: {
      documentDraftSourceJson: Prisma.DbNull,
      documentDraft: Prisma.DbNull,
      documentDraftUpdatedAt: null,
    },
  });
  if (updated.count === 0) throw new StatusError(409, "This action-page draft changed while it was being discarded. Reload it and try again.");
  return { status: "deleted" };
}
