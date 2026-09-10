/**
 * The only server-brokered review operation left: retrying an AI QA review
 * runs an LLM server-side (needs the OpenRouter key), so it can't be a direct
 * reducer call from the browser like the other mutations.
 */
export async function retryReview(body: {
  correlationId: string,
  question: string,
  reason: string,
  response: string,
}): Promise<void> {
  const res = await fetch("/api/mcp-review/retry-review", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP review API error (${res.status}): ${text}`);
  }
}

/**
 * Backfills the automated QA review for a batch of currently-unreviewed rows
 * (the ones the reviewer is looking at). Same server-side-LLM reason as
 * retryReview. Fire-and-forget: the endpoint schedules the reviews in the
 * background with bounded concurrency and returns immediately, so the UI never
 * blocks; verdicts arrive over the live WS subscription.
 */
export async function reviewVisible(items: Array<{
  correlationId: string,
  question: string,
  reason: string,
  response: string,
}>): Promise<void> {
  const res = await fetch("/api/mcp-review/backfill-visible", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP review API error (${res.status}): ${text}`);
  }
}
