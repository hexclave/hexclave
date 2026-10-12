import { requireInternalAiChatReviewer } from "@/lib/server/internal-auth";
import { reviewMcpCall } from "@/lib/server/qa-reviewer";
import { signSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { handleApiError, readJsonBody, successResponse } from "@/lib/server/route-utils";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { after } from "next/server";
import { z } from "zod";

// Upper bound on rows one click can enqueue; the caller's visible window is the
// newest ~50 (MAX_LIVE_LOG_ROWS in the module), so 50 covers a full window.
const MAX_BACKFILL_ITEMS = 50;
// Bounded fan-out into the LLM reviewer so a click can't spawn 50 concurrent
// Grok + deepwiki runs. Rows drain a few at a time.
const REVIEW_CONCURRENCY = 4;

const bodySchema = z.object({
  items: z.array(z.object({
    correlationId: z.string(),
    question: z.string(),
    reason: z.string(),
    response: z.string(),
  })).max(MAX_BACKFILL_ITEMS),
});

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Backfills the automated QA review for the unreviewed rows the reviewer is
// currently looking at. The caller only sends rows with qaReviewedAt == null.
// No claim/lease: an in-flight inline review of the same row can rarely race
// this (one wasted LLM run, last-writer-wins on update_mcp_qa_review) — accepted
// at this volume. Runs in the background so the UI never blocks; results stream
// back over the reviewer's live WS subscription.
export async function POST(req: Request): Promise<Response> {
  try {
    const { user } = await requireInternalAiChatReviewer(req);
    const { items } = bodySchema.parse(await readJsonBody(req));
    after(async () => {
      await runWithConcurrency(items, REVIEW_CONCURRENCY, async (item) => {
        try {
          const spacetimeToken = await signSpacetimeToken({ subject: user.id });
          await reviewMcpCall(spacetimeToken, item);
        } catch (err) {
          captureError("internal-tool-mcp-review-backfill-visible-item", err);
        }
      });
    });
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-mcp-review-backfill-visible", err);
  }
}
