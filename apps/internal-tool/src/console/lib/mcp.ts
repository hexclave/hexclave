import { captureError } from "@hexclave/shared/dist/utils/errors";
import { FEATURE_REQUEST_FLAG_TYPE } from "../../lib/feature-request-flag";
import type { McpCallLogRow } from "../../types";
import { QA_REVIEW_FAILED_THRESHOLD_MS, qaReviewStartedAt } from "../../utils";
import type { Tone } from "../ui/primitives";

/**
 * Display semantics for an MCP call's automated QA review, derived in one place so the table, the
 * detail panel and the overview never disagree about what "failed" or "needs review" means.
 *
 * `now` is a parameter (not `Date.now()`) because a pending review becomes "review-failed" purely
 * by the clock advancing; callers pass a ticking clock (useClockTick) so that flip shows up.
 */
export type QaStatus =
  | { kind: "scored", score: number, band: "pass" | "warn" | "fail" }
  | { kind: "error", message: string }
  | { kind: "review-failed" }
  | { kind: "pending" };

export function qaStatus(row: McpCallLogRow, now: number): QaStatus {
  if (row.qaErrorMessage != null && row.qaErrorMessage !== "") return { kind: "error", message: row.qaErrorMessage };
  if (row.qaOverallScore != null) {
    const score = row.qaOverallScore;
    return { kind: "scored", score, band: score >= 80 ? "pass" : score >= 50 ? "warn" : "fail" };
  }
  return now - qaReviewStartedAt(row).getTime() > QA_REVIEW_FAILED_THRESHOLD_MS ? { kind: "review-failed" } : { kind: "pending" };
}

export function qaStatusTone(status: QaStatus): Tone {
  switch (status.kind) {
    case "scored": { return status.band === "pass" ? "green" : status.band === "warn" ? "amber" : "red"; }
    case "error": { return "red"; }
    case "review-failed": { return "amber"; }
    case "pending": { return "neutral"; }
  }
}

export function qaStatusLabel(status: QaStatus): string {
  switch (status.kind) {
    case "scored": { return String(status.score); }
    case "error": { return "Error"; }
    case "review-failed": { return "Failed"; }
    case "pending": { return "Pending"; }
  }
}

export function scoreTextClass(score: number): string {
  return score >= 80 ? "text-emerald-600 dark:text-emerald-400" : score >= 50 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
}

/** A retry only makes sense when no verdict landed: the review errored or silently never finished. */
export function isAiReviewRetryable(row: McpCallLogRow, now: number): boolean {
  if (row.qaReviewedAt != null) return false;
  const status = qaStatus(row, now);
  return status.kind === "error" || status.kind === "review-failed";
}

export function isCallError(row: { errorMessage?: string | null }): boolean {
  return row.errorMessage != null && row.errorMessage !== "";
}

export function needsHumanReview(row: McpCallLogRow): boolean {
  return row.qaNeedsHumanReview === true && row.humanReviewedAt == null;
}

export type QaFlag = { type: string, severity: string, explanation: string, summary?: string };

function isQaFlag(value: unknown): value is QaFlag {
  return typeof value === "object" && value != null
    && "type" in value && typeof value.type === "string"
    && "severity" in value && typeof value.severity === "string"
    && "explanation" in value && typeof value.explanation === "string";
}

/** Parses `qaFlagsJson`, dropping malformed entries (reported, never thrown: one bad row must not break a page). */
export function parseQaFlags(json: string | null | undefined): QaFlag[] {
  if (json == null || json === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    captureError("console-qa-flags-json", new Error("Malformed qaFlagsJson"));
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isQaFlag);
}

/** Flag types other than the feature-request marker, which is surfaced separately. */
export function qualityFlagTypes(row: McpCallLogRow): string[] {
  return Array.from(new Set(parseQaFlags(row.qaFlagsJson).map(flag => flag.type).filter(type => type !== FEATURE_REQUEST_FLAG_TYPE)));
}

export const SEVERITY_TONE = new Map<string, Tone>([
  ["critical", "red"],
  ["high", "red"],
  ["medium", "amber"],
  ["low", "neutral"],
]);
