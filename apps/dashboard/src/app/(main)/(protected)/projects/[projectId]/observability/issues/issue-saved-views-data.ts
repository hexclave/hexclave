import { yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { getErrorMessage } from "../format";
import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";
import {
  isObservabilityTimeRangeHours,
} from "../filters";
import {
  parseIssueFilters,
  type IssueFilters,
} from "./issue-filters";
import { serviceIdentityToSelectValue } from "../service-identity";
import * as yup from "yup";

export type SavedIssueSearchViewVisibility = "private" | "project";

export type SavedIssueSearchQuery = {
  version: number,
  filters: Partial<Record<string, string>>,
};

export type SavedIssueSearchView = {
  id: string,
  schema_version: number,
  name: string,
  visibility: SavedIssueSearchViewVisibility,
  owner_user_id: string | null,
  query: SavedIssueSearchQuery,
  created_at_millis: number,
  updated_at_millis: number,
};

export type SavedIssueSearchViewMutation = {
  name: string,
  visibility: SavedIssueSearchViewVisibility,
  query: SavedIssueSearchQuery,
};

const savedIssueSearchQuerySchema = yup.object({
  version: yup.number().oneOf([1]).defined(),
  filters: yupRecord(
    yupString().max(128).defined(),
    yupString().max(256).defined(),
  ).defined(),
}).defined();

const savedIssueSearchViewSchema = yup.object({
  id: yupString().uuid().defined(),
  schema_version: yup.number().oneOf([1]).defined(),
  name: yupString().defined(),
  visibility: yupString().oneOf(["private", "project"]).defined(),
  owner_user_id: yupString().uuid().nullable().defined(),
  query: savedIssueSearchQuerySchema,
  created_at_millis: yup.number().integer().min(0).defined(),
  updated_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const savedIssueSearchViewListSchema = yup.object({
  items: yup.array(savedIssueSearchViewSchema).defined(),
  has_more: yup.boolean().defined(),
}).defined();

const savedIssueSearchViewMutationSchema = yup.object({
  name: yupString().defined(),
  visibility: yupString().oneOf(["private", "project"]).defined(),
  query: savedIssueSearchQuerySchema,
}).defined();

async function readJsonOrThrow(response: Response, operation: string): Promise<Json> {
  if (!response.ok) {
    throw new HexclaveAssertionError(`${operation} failed with status ${response.status}`);
  }
  return await response.json();
}

export function issueFiltersToSavedIssueSearchQuery(filters: IssueFilters): SavedIssueSearchQuery {
  const savedFilters: Record<string, string> = {
    record: "issue",
    hours: String(filters.hours),
    limit: "50",
  };
  if (filters.status !== "all") savedFilters.status = filters.status;
  if (filters.service !== null) savedFilters.service = filters.service.name;
  if (filters.environment !== null) savedFilters.environment = filters.environment;
  if (filters.handled !== "all") savedFilters.handled = filters.handled === "handled" ? "true" : "false";
  const search = filters.search.trim();
  if (search !== "") savedFilters.message = search;
  return { version: 1, filters: savedFilters };
}

export function savedIssueSearchQueryToIssueFilters(query: SavedIssueSearchQuery): IssueFilters {
  const params = new URLSearchParams();
  const filters = query.filters;
  // Omit (rather than defaulting to "all") so absent status falls back to
  // parseIssueStatusFilter's DEFAULT_ISSUE_FILTERS.status — saved queries must
  // fail closed to the issue-list default, not silently widen to all statuses.
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.hours !== undefined) params.set("range", filters.hours);
  if (filters.service !== undefined && filters.service !== "") {
    params.set("service", serviceIdentityToSelectValue({ namespace: "", name: filters.service }));
  }
  if (filters.environment !== undefined) params.set("environment", filters.environment);
  if (filters.handled === "true" || filters.handled === "1") params.set("handled", "handled");
  if (filters.handled === "false" || filters.handled === "0") params.set("handled", "unhandled");
  if (filters.message !== undefined) params.set("search", filters.message);
  return parseIssueFilters(params);
}

export function savedIssueSearchViewMutationForFilters(name: string, filters: IssueFilters): SavedIssueSearchViewMutation {
  return {
    name,
    visibility: "project",
    query: issueFiltersToSavedIssueSearchQuery(filters),
  };
}

export async function fetchSavedIssueSearchViews(adminApp: object): Promise<SavedIssueSearchView[]> {
  const params = new URLSearchParams({ limit: "100" });
  const response = await sendInternalAdminRequest(adminApp, `/internal/issues/search-views?${params.toString()}`, { method: "GET" });
  const body = await savedIssueSearchViewListSchema.validate(await readJsonOrThrow(response, "Loading saved issue search views"));
  return body.items;
}

export async function createSavedIssueSearchView(
  adminApp: object,
  mutation: SavedIssueSearchViewMutation,
): Promise<SavedIssueSearchView> {
  const body = await savedIssueSearchViewMutationSchema.validate(mutation);
  const response = await sendInternalAdminRequest(adminApp, "/internal/issues/search-views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await savedIssueSearchViewSchema.validate(await readJsonOrThrow(response, "Creating saved issue search view"));
}

export async function updateSavedIssueSearchView(
  adminApp: object,
  viewId: string,
  mutation: SavedIssueSearchViewMutation,
): Promise<SavedIssueSearchView> {
  const body = await savedIssueSearchViewMutationSchema.validate(mutation);
  const response = await sendInternalAdminRequest(adminApp, `/internal/issues/search-views/${encodeURIComponent(viewId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await savedIssueSearchViewSchema.validate(await readJsonOrThrow(response, "Updating saved issue search view"));
}

export async function deleteSavedIssueSearchView(adminApp: object, viewId: string): Promise<void> {
  const response = await sendInternalAdminRequest(adminApp, `/internal/issues/search-views/${encodeURIComponent(viewId)}`, { method: "DELETE" });
  if (!response.ok) throw new HexclaveAssertionError(`Deleting saved issue search view failed with status ${response.status}`);
}

export function savedIssueSearchViewVisibilityLabel(visibility: SavedIssueSearchViewVisibility): string {
  return visibility === "project" ? "Project" : "Private";
}

export function savedIssueSearchViewQueryIsCompatible(query: SavedIssueSearchQuery): boolean {
  const rawHours = Number(query.filters.hours);
  const handled = query.filters.handled;
  const supportedKeys = new Set(["record", "hours", "limit", "status", "service", "environment", "handled", "message"]);
  return query.version === 1
    && query.filters.record === "issue"
    && Object.keys(query.filters).every((key) => supportedKeys.has(key))
    && isObservabilityTimeRangeHours(rawHours)
    && (handled === undefined || handled === "true" || handled === "false" || handled === "1" || handled === "0");
}
