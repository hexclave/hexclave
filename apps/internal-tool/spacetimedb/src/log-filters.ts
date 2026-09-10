export const QA_REVIEW_FAILED_THRESHOLD_MICROS = 2n * 60n * 1000n * 1000n;

type TimestampLike = { microsSinceUnixEpoch: bigint };

type AiFilterableRow = {
  systemPromptId: string,
  modelId: string,
  mode: string,
  isAuthenticated: boolean,
  errorMessage: string | undefined,
};

export type AiLogFilters = {
  systemPromptId: string | undefined,
  modelId: string | undefined,
  mode: string | undefined,
  isAuthenticated: boolean | undefined,
  hasError: boolean | undefined,
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
  toolName: string | undefined,
  hasError: boolean | undefined,
  qaState: string | undefined,
  humanReviewState: string | undefined,
};

const FEATURE_REQUEST_FLAG_TYPE = 'unsupported_feature_request';

function hasFeatureRequestFlag(flagsJson: string | undefined): boolean {
  if (flagsJson == null || flagsJson === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(flagsJson);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some(candidate => (
    candidate != null
    && typeof candidate === 'object'
    && 'type' in candidate
    && candidate.type === FEATURE_REQUEST_FLAG_TYPE
  ));
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
  switch (state) {
    case 'pending': return row.qaOverallScore == null && !hasQaError && !reviewFailed;
    case 'review-failed': return reviewFailed;
    case 'error': return hasQaError;
    case 'pass': return row.qaOverallScore != null && row.qaOverallScore >= 80;
    case 'warn': return row.qaOverallScore != null && row.qaOverallScore >= 50 && row.qaOverallScore < 80;
    case 'fail': return row.qaOverallScore != null && row.qaOverallScore < 50;
    case 'feature-request': return hasFeatureRequestFlag(row.qaFlagsJson);
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
  if (filters.systemPromptId != null && row.systemPromptId !== filters.systemPromptId) return false;
  if (filters.modelId != null && row.modelId !== filters.modelId) return false;
  if (filters.mode != null && row.mode !== filters.mode) return false;
  if (filters.isAuthenticated != null && row.isAuthenticated !== filters.isAuthenticated) return false;
  if (filters.hasError != null && hasErrorMessage(row.errorMessage) !== filters.hasError) return false;
  return true;
}

export function mcpLogMatches(row: McpFilterableRow, filters: McpLogFilters, nowMicros: bigint): boolean {
  if (filters.toolName != null && row.toolName !== filters.toolName) return false;
  if (filters.hasError != null && hasErrorMessage(row.errorMessage) !== filters.hasError) return false;
  if (filters.qaState != null && !mcpQaStateMatches(row, filters.qaState, nowMicros)) return false;
  if (filters.humanReviewState != null && !mcpHumanReviewStateMatches(row, filters.humanReviewState)) return false;
  return true;
}
