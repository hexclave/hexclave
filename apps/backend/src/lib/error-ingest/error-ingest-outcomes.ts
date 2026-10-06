
export type ErrorIngestItemType = "event" | "log" | "span" | "transaction" | "attachment" | "client_report" | "unknown";

export type ErrorIngestOutcomeStatus =
  | "accepted"
  | "filtered"
  | "rate_limited"
  | "rejected"
  | "deduplicated"
  | "dropped"
  | "queued";

export type ErrorIngestFilterReason = "configured_filter" | "privacy" | "sampling";
export type ErrorIngestRateLimitReason = "quota" | "rate_limit";
export type ErrorIngestRejectReason = "auth" | "invalid" | "payload_too_large" | "unsupported";
export type ErrorIngestDropReason = "delivery_failed" | "internal" | "queue_full" | "shutdown";
export type ErrorIngestQueueReason = "offline" | "retryable";

export type ErrorIngestItemDescriptor = {
  itemId: string,
  itemType: ErrorIngestItemType,
  eventId?: string,
};

export type ErrorIngestItemOutcomeDetails =
  | { status: "accepted" }
  | { status: "filtered", reason: ErrorIngestFilterReason }
  | { status: "rate_limited", reason: ErrorIngestRateLimitReason, retryAfterMs?: number }
  | { status: "rejected", reason: ErrorIngestRejectReason }
  | { status: "deduplicated", canonicalItemId: string }
  | { status: "dropped", reason: ErrorIngestDropReason }
  | { status: "queued", reason: ErrorIngestQueueReason, retryAfterMs?: number };

export type ErrorIngestItemOutcome = ErrorIngestItemDescriptor & ErrorIngestItemOutcomeDetails;

export type ErrorIngestBatchStatus = ErrorIngestOutcomeStatus | "partial";

export type ErrorIngestBatchCounts = Readonly<Record<ErrorIngestOutcomeStatus, number>>;

export type ErrorIngestOutcomeSummary = {
  status: ErrorIngestBatchStatus,
  counts: ErrorIngestBatchCounts,
  reason?: "empty_batch",
};

export const ERROR_INGEST_OUTCOME_STATUSES: readonly ErrorIngestOutcomeStatus[] = [
  "accepted",
  "filtered",
  "rate_limited",
  "rejected",
  "deduplicated",
  "dropped",
  "queued",
];

export function createErrorIngestItemOutcome(
  item: ErrorIngestItemDescriptor,
  details: ErrorIngestItemOutcomeDetails,
): ErrorIngestItemOutcome {
  return { ...item, ...details };
}

function emptyCounts(): Record<ErrorIngestOutcomeStatus, number> {
  return {
    accepted: 0,
    filtered: 0,
    rate_limited: 0,
    rejected: 0,
    deduplicated: 0,
    dropped: 0,
    queued: 0,
  };
}

export function countErrorIngestOutcomes(
  outcomes: readonly { status: ErrorIngestOutcomeStatus }[],
): ErrorIngestBatchCounts {
  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

export function summarizeErrorIngestOutcomes(
  outcomes: readonly { status: ErrorIngestOutcomeStatus }[],
): ErrorIngestOutcomeSummary {
  const counts = countErrorIngestOutcomes(outcomes);

  if (outcomes.length === 0) return { status: "rejected", counts, reason: "empty_batch" };
  const firstStatus = outcomes[0].status;
  for (const outcome of outcomes.slice(1)) {
    if (outcome.status !== firstStatus) return { status: "partial", counts };
  }
  return { status: firstStatus, counts };
}
