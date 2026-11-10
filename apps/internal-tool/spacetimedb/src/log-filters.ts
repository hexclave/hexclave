import { featureRequestFromFlagsJson } from './feature-request-flag';

export const QA_REVIEW_FAILED_THRESHOLD_MICROS = 2n * 60n * 1000n * 1000n;

type TimestampLike = { microsSinceUnixEpoch: bigint };

type AiFilterableRow = {
  systemPromptId: string,
  modelId: string,
  mode: string,
  isAuthenticated: boolean,
  errorMessage: string | undefined,
};

// List filters match a row whose value is any of the listed values; an omitted or empty list is
// no filter (the UI's multi-selects use "nothing selected" to mean "all").
export type AiLogFilters = {
  systemPromptIds?: readonly string[],
  modelIds?: readonly string[],
  mode?: string,
  isAuthenticated?: boolean,
  hasError?: boolean,
};

type McpFilterableRow = {
  toolName: string,
  errorMessage: string | undefined,
  qaOverallScore: number | undefined,
  qaErrorMessage: string | undefined,
  qaNeedsHumanReview: boolean | undefined,
  humanReviewedAt: TimestampLike | undefined,
  createdAt: TimestampLike,
  qaReviewRequestedAt: TimestampLike,
  qaFlagsJson: string | undefined,
};

export type McpLogFilters = {
  toolNames?: readonly string[],
  hasError?: boolean,
  qaStates?: readonly string[],
  humanReviewStates?: readonly string[],
};

function isListFilter(values: readonly string[] | undefined): values is readonly string[] {
  return values != null && values.length > 0;
}

function hasErrorMessage(value: string | undefined): boolean {
  return value != null && value !== '';
}

function mcpQaStateMatches(row: McpFilterableRow, state: string, nowMicros: bigint): boolean {
  const hasQaError = hasErrorMessage(row.qaErrorMessage);
  const reviewStartedAtMicros = row.qaReviewRequestedAt.microsSinceUnixEpoch > row.createdAt.microsSinceUnixEpoch
    ? row.qaReviewRequestedAt.microsSinceUnixEpoch
    : row.createdAt.microsSinceUnixEpoch;
  const reviewFailed = row.qaOverallScore == null && !hasQaError && nowMicros - reviewStartedAtMicros > QA_REVIEW_FAILED_THRESHOLD_MICROS;
  // The score bands exclude errored rows so the states partition every row the way the grid
  // renders them: a row with both a score and a review error shows the error badge, not the score.
  const score = hasQaError ? undefined : row.qaOverallScore;
  switch (state) {
    case 'pending': return row.qaOverallScore == null && !hasQaError && !reviewFailed;
    case 'review-failed': return reviewFailed;
    case 'error': return hasQaError;
    case 'pass': return score != null && score >= 80;
    case 'warn': return score != null && score >= 50 && score < 80;
    case 'fail': return score != null && score < 50;
    case 'feature-request': return featureRequestFromFlagsJson(row.qaFlagsJson) != null;
    default: throw new Error(`Unexpected QA state after validation: ${state}`);
  }
}

function mcpHumanReviewStateMatches(row: McpFilterableRow, state: string): boolean {
  switch (state) {
    case 'required': return row.qaNeedsHumanReview === true && row.humanReviewedAt == null;
    case 'reviewed': return row.humanReviewedAt != null;
    case 'not-reviewed': return row.humanReviewedAt == null;
    default: throw new Error(`Unexpected human review state after validation: ${state}`);
  }
}

export function aiLogMatches(row: AiFilterableRow, filters: AiLogFilters): boolean {
  if (isListFilter(filters.systemPromptIds) && !filters.systemPromptIds.includes(row.systemPromptId)) return false;
  if (isListFilter(filters.modelIds) && !filters.modelIds.includes(row.modelId)) return false;
  if (filters.mode != null && row.mode !== filters.mode) return false;
  if (filters.isAuthenticated != null && row.isAuthenticated !== filters.isAuthenticated) return false;
  if (filters.hasError != null && hasErrorMessage(row.errorMessage) !== filters.hasError) return false;
  return true;
}

export function mcpLogMatches(row: McpFilterableRow, filters: McpLogFilters, nowMicros: bigint): boolean {
  if (isListFilter(filters.toolNames) && !filters.toolNames.includes(row.toolName)) return false;
  if (filters.hasError != null && hasErrorMessage(row.errorMessage) !== filters.hasError) return false;
  if (isListFilter(filters.qaStates) && !filters.qaStates.some(state => mcpQaStateMatches(row, state, nowMicros))) return false;
  if (isListFilter(filters.humanReviewStates) && !filters.humanReviewStates.some(state => mcpHumanReviewStateMatches(row, state))) return false;
  return true;
}
