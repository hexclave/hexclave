import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { ObservabilityTimeRangeHours } from "../filters";


export const ISSUE_RANGE_PARAM_KEY = "range";
export const DEFAULT_ISSUE_RANGE_HOURS: ObservabilityTimeRangeHours = 24;

export function issuesListHref(projectId: string): string {
  return urlString`/projects/${projectId}/observability/issues`;
}

export function issueSearchHref(projectId: string, search: string): string {
  return `${issuesListHref(projectId)}?status=all&search=${encodeURIComponent(search)}`;
}

export function issueDetailHref(
  projectId: string,
  idOrShortId: string,
  options: { rangeHours?: ObservabilityTimeRangeHours } = {},
): string {
  const base = urlString`/projects/${projectId}/observability/issues/${idOrShortId}`;
  if (options.rangeHours == null || options.rangeHours === DEFAULT_ISSUE_RANGE_HOURS) return base;
  return `${base}?${ISSUE_RANGE_PARAM_KEY}=${encodeURIComponent(String(options.rangeHours))}`;
}

export { traceDetailHref, type TraceHighlight } from "../observability-links";
