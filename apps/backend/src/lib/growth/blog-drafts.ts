import { globalPrismaClient } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { postToEveForResult } from "./eve-dispatch";

/**
 * On-demand blog-draft generation for `publish_blog` action items.
 *
 * WHY THIS EXISTS: the SEO & AEO analysis topic used to write a complete publishable post inline,
 * during the run. Measured on a real run (2026-08-06) that made it the slowest phase by far —
 * 7m44s against ~2m for the other analysis topics — and since the analysis phases run in parallel,
 * the slowest one alone sets the whole run's wall clock. Worse, the draft is wasted work whenever
 * the customer picks a different piece from the content plan, or none at all. So the run now emits
 * only the IDEA (see the seo-aeo-strategy skill), and the actual post is generated here, when a
 * human asks for it.
 *
 * The generation is SYNCHRONOUS on purpose (the /blog-draft channel route mirrors /interview and
 * /chat rather than the fire-and-ack run routes): there is exactly one consumer, a human waiting on
 * a button, and a synchronous call means no phase row, no polling, and no partially-written state
 * to reconcile if it fails. A failure leaves the item exactly as it was — idea, no draft.
 *
 * The agent session for this needs NO backend calls: everything it reasons from (the idea and the
 * product context) is passed inline, so no run token is minted and no agent-write surface is added.
 */

/** Upper bound on one generation. Long because it awaits a full post; the route's maxDuration is set above it. */
const BLOG_DRAFT_GENERATION_TIMEOUT_MS = 4 * 60 * 1000;

/** The idea the analysis run attaches to a `publish_blog` item, in the payload's snake_case wire shape. */
export type GrowthBlogIdea = {
  title: string,
  targetIntent: string | null,
  aeoAngle: string | null,
  outlineSummary: string | null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Reads `payload.blog_idea` out of an action item's (untrusted-shape) stored payload. Returns null
 * when the payload is not a blog idea we can generate from — the agent writes this field, so the
 * shape is validated here rather than assumed.
 */
export function extractGrowthBlogIdea(payload: unknown): GrowthBlogIdea | null {
  if (!isRecord(payload)) return null;
  const idea = payload.blog_idea;
  if (!isRecord(idea)) return null;
  const title = readOptionalString(idea.title);
  if (title == null) return null;
  return {
    title,
    targetIntent: readOptionalString(idea.target_intent),
    aeoAngle: readOptionalString(idea.aeo_angle),
    outlineSummary: readOptionalString(idea.outline_summary),
  };
}

/** Reads an already-generated draft out of a payload, so a second generate call is a cheap no-op. */
export function extractGrowthBlogDraftMarkdown(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return readOptionalString(payload.draft_markdown);
}

/**
 * Narrows the Eve response. `unknown` in, validated out — the agent is a separate process, so a
 * malformed body must fail loudly here rather than land in a customer-visible payload column.
 */
export function parseGrowthBlogDraftResponse(response: unknown): string {
  if (!isRecord(response)) {
    throw new StatusError(502, "The draft generator returned an unexpected response. Try again in a moment.");
  }
  const markdown = readOptionalString(response.draft_markdown);
  if (markdown == null) {
    throw new StatusError(502, "The draft generator returned an empty draft. Try again in a moment.");
  }
  return markdown;
}

async function requireBlogActionItem(tenancy: Tenancy, actionItemId: string) {
  const item = await globalPrismaClient.growthActionItem.findFirst({
    where: { id: actionItemId, projectId: tenancy.project.id, branchId: tenancy.branchId },
    select: { id: true, typeId: true, title: true, description: true, payload: true },
  });
  // Same 404 for "wrong tenancy" and "does not exist" — never confirm an id from another project.
  if (item == null) throw new StatusError(404, "Action item not found.");
  if (item.typeId !== "publish_blog") {
    throw new StatusError(400, "Only blog action items can generate a draft.");
  }
  return item;
}

/**
 * Generates (or returns the already-generated) draft for a `publish_blog` action item and stores it
 * in the item's payload as `draft_markdown`, alongside the idea it came from.
 */
export async function generateGrowthBlogDraft(tenancy: Tenancy, actionItemId: string): Promise<{ draftMarkdown: string, generated: boolean }> {
  const item = await requireBlogActionItem(tenancy, actionItemId);

  const existing = extractGrowthBlogDraftMarkdown(item.payload);
  // Idempotent by design: the button can be double-clicked, and regenerating would silently discard
  // a draft the customer may already have read. Replacing a draft is a separate, explicit action.
  if (existing != null) return { draftMarkdown: existing, generated: false };

  const idea = extractGrowthBlogIdea(item.payload);
  if (idea == null) {
    throw new StatusError(400, "This action item has no blog idea attached, so there is nothing to write from.");
  }

  const onboarding = await globalPrismaClient.growthOnboarding.findFirst({
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId },
    select: { websiteUrl: true, companySummary: true, additionalNotes: true },
  });

  const response = await postToEveForResult("/blog-draft", {
    project_id: tenancy.project.id,
    branch_id: tenancy.branchId,
    action_item_id: item.id,
    action_title: item.title,
    action_description: item.description,
    blog_idea: {
      title: idea.title,
      target_intent: idea.targetIntent,
      aeo_angle: idea.aeoAngle,
      outline_summary: idea.outlineSummary,
    },
    product: {
      website_url: onboarding?.websiteUrl ?? null,
      company_summary: onboarding?.companySummary ?? null,
      additional_notes: onboarding == null ? null : onboarding.additionalNotes,
    },
  }, { timeoutMs: BLOG_DRAFT_GENERATION_TIMEOUT_MS });

  const draftMarkdown = parseGrowthBlogDraftResponse(response);

  // Merge rather than replace: the idea stays in the payload so the reader can still see what the
  // analysis proposed, and so a future "regenerate" has its source of truth.
  const basePayload = isRecord(item.payload) ? item.payload : {};
  await globalPrismaClient.growthActionItem.updateMany({
    where: { id: item.id, projectId: tenancy.project.id, branchId: tenancy.branchId },
    data: { payload: { ...basePayload, draft_markdown: draftMarkdown } },
  });

  return { draftMarkdown, generated: true };
}
