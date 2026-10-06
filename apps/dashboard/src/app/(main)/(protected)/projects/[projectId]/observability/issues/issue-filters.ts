import type { DataGridSortModel } from "@hexclave/dashboard-ui-components";
import {
  ALL_SERVICES_SELECT_VALUE,
  isObservabilityTimeRangeHours,
  type ObservabilityTimeRangeHours,
} from "../filters";
import {
  selectValueToServiceIdentity,
  serviceIdentityToSelectValue,
  type ServiceIdentity,
} from "../service-identity";
import { DEFAULT_ISSUE_RANGE_HOURS, ISSUE_RANGE_PARAM_KEY } from "./issue-links";
import {
  ISSUE_STATUSES, type IssueHandledFilter, type IssueListSortField,
  type IssueStatus,
} from "./issues-data";


export const ALL_STATUSES_FILTER_VALUE = "all";
export type IssueStatusFilter = IssueStatus | typeof ALL_STATUSES_FILTER_VALUE;

export const ISSUE_HANDLED_FILTERS: readonly IssueHandledFilter[] = ["all", "unhandled", "handled"];

export type IssueFilters = {
  hours: ObservabilityTimeRangeHours,
  status: IssueStatusFilter,
  service: ServiceIdentity | null,
  environment: string | null,
  handled: IssueHandledFilter,
  search: string,
};

export const DEFAULT_ISSUE_FILTERS: IssueFilters = {
  hours: DEFAULT_ISSUE_RANGE_HOURS,
  status: "unresolved",
  service: null,
  environment: null,
  handled: "all",
  search: "",
};

const PARAM_KEYS = {
  hours: ISSUE_RANGE_PARAM_KEY,
  status: "status",
  service: "service",
  environment: "environment",
  handled: "handled",
  search: "search",
} as const;

export function parseIssueFilters(params: URLSearchParams): IssueFilters {
  const rawHandled = params.get(PARAM_KEYS.handled);
  const rawService = params.get(PARAM_KEYS.service);
  const rawEnvironment = params.get(PARAM_KEYS.environment);

  return {
    hours: parseIssueRangeHours(params),
    status: parseIssueStatusFilter(params.get(PARAM_KEYS.status)),
    service: rawService == null || rawService === ALL_SERVICES_SELECT_VALUE
      ? null
      : safeSelectValueToServiceIdentity(rawService),
    environment: rawEnvironment != null && rawEnvironment !== "" ? rawEnvironment : null,
    handled: ISSUE_HANDLED_FILTERS.find((candidate) => candidate === rawHandled)
      ?? DEFAULT_ISSUE_FILTERS.handled,
    search: params.get(PARAM_KEYS.search) ?? DEFAULT_ISSUE_FILTERS.search,
  };
}

export function parseIssueRangeHours(params: Pick<URLSearchParams, "get">): ObservabilityTimeRangeHours {
  const rawHours = Number(params.get(PARAM_KEYS.hours));
  return isObservabilityTimeRangeHours(rawHours) ? rawHours : DEFAULT_ISSUE_FILTERS.hours;
}

export function parseIssueStatusFilter(raw: string | null): IssueStatusFilter {
  if (raw === ALL_STATUSES_FILTER_VALUE) return ALL_STATUSES_FILTER_VALUE;
  return ISSUE_STATUSES.find((candidate) => candidate === raw) ?? DEFAULT_ISSUE_FILTERS.status;
}

function safeSelectValueToServiceIdentity(value: string): ServiceIdentity | null {
  try {
    return selectValueToServiceIdentity(value);
  } catch {
    return null;
  }
}

export function serializeIssueFilters(filters: IssueFilters, params: URLSearchParams): URLSearchParams {
  const setOrDelete = (key: string, value: string | null) => {
    if (value == null) params.delete(key);
    else params.set(key, value);
  };
  setOrDelete(PARAM_KEYS.hours, filters.hours === DEFAULT_ISSUE_FILTERS.hours ? null : String(filters.hours));
  setOrDelete(PARAM_KEYS.status, filters.status === DEFAULT_ISSUE_FILTERS.status ? null : filters.status);
  setOrDelete(PARAM_KEYS.service, filters.service == null ? null : serviceIdentityToSelectValue(filters.service));
  setOrDelete(PARAM_KEYS.environment, filters.environment);
  setOrDelete(PARAM_KEYS.handled, filters.handled === DEFAULT_ISSUE_FILTERS.handled ? null : filters.handled);
  setOrDelete(PARAM_KEYS.search, filters.search.trim() === "" ? null : filters.search);
  return params;
}

export function issueFiltersAreDefault(filters: IssueFilters): boolean {
  return serializeIssueFilters(filters, new URLSearchParams()).toString() === "";
}


const SORTABLE_COLUMN_FIELDS = new Map<string, IssueListSortField>([
  ["events", "events"],
  ["users", "users"],
  ["lastSeen", "last_seen"],
  ["firstSeen", "first_seen"],
]);

export const DEFAULT_ISSUE_SORT: { field: IssueListSortField, direction: "asc" | "desc" } = {
  field: "last_seen",
  direction: "desc",
};

export function isSortableIssueColumn(columnId: string): boolean {
  return SORTABLE_COLUMN_FIELDS.has(columnId);
}

export function resolveIssueSort(sorting: DataGridSortModel): { field: IssueListSortField, direction: "asc" | "desc" } {
  if (sorting.length === 0) return DEFAULT_ISSUE_SORT;
  const first = sorting[0];
  const field = SORTABLE_COLUMN_FIELDS.get(first.columnId);
  if (field == null) return DEFAULT_ISSUE_SORT;
  return { field, direction: first.direction };
}
