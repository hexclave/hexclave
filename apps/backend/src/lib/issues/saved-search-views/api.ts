import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  SAVED_ISSUE_SEARCH_VIEW_LIST_MAX,
  type SavedIssueSearchViewListResponse,
  type SavedIssueSearchViewMutation,
  type SavedIssueSearchViewResponse,
  parseSavedIssueSearchViewMutation,
  toSavedIssueSearchViewResponse,
} from "./contract";
import {
  createSavedIssueSearchView,
  deleteSavedIssueSearchView,
  getSavedIssueSearchView,
  listSavedIssueSearchViews,
  updateSavedIssueSearchView,
  type SavedIssueSearchViewMutationAuthorization,
  type SavedIssueSearchViewPersistenceDependencies,
} from "./persistence";

export const SAVED_ISSUE_SEARCH_VIEW_DEFAULT_LIST_LIMIT = 50;

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

export function parseSavedIssueSearchViewListLimit(value: string | undefined): number {
  if (value === undefined) return SAVED_ISSUE_SEARCH_VIEW_DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > SAVED_ISSUE_SEARCH_VIEW_LIST_MAX) {
    return badRequest(`limit must be an integer between 1 and ${SAVED_ISSUE_SEARCH_VIEW_LIST_MAX}`);
  }
  return limit;
}

export async function listSavedIssueSearchViewResponses(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  limit: number,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchViewListResponse> {
  const result = await listSavedIssueSearchViews(options);
  return {
    items: result.items.map(toSavedIssueSearchViewResponse),
    has_more: result.hasMore,
  };
}

export async function getSavedIssueSearchViewResponse(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  viewId: string,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchViewResponse | null> {
  const view = await getSavedIssueSearchView(options);
  return view === null ? null : toSavedIssueSearchViewResponse(view);
}

export async function createSavedIssueSearchViewResponse(options: {
  tenancy: Tenancy,
  actorUserId: string | null,
  body: unknown,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchViewResponse> {
  const mutation = parseSavedIssueSearchViewMutation(options.body, options.actorUserId);
  const view = await createSavedIssueSearchView({
    tenancy: options.tenancy,
    actorUserId: options.actorUserId,
    mutation,
    dependencies: options.dependencies,
  });
  return toSavedIssueSearchViewResponse(view);
}

export async function updateSavedIssueSearchViewResponse(options: {
  tenancy: Tenancy,
  authorization: SavedIssueSearchViewMutationAuthorization,
  viewId: string,
  body: unknown,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<SavedIssueSearchViewResponse> {
  const mutation = parseSavedIssueSearchViewMutation(
    options.body,
    options.authorization.kind === "creator" ? options.authorization.actorUserId : null,
    { allowPrivateWithoutActor: options.authorization.kind === "admin" },
  );
  const view = await updateSavedIssueSearchView({
    tenancy: options.tenancy,
    authorization: options.authorization,
    viewId: options.viewId,
    mutation,
    dependencies: options.dependencies,
  });
  return toSavedIssueSearchViewResponse(view);
}

export async function deleteSavedIssueSearchViewForActor(options: {
  tenancy: Tenancy,
  authorization: SavedIssueSearchViewMutationAuthorization,
  viewId: string,
  dependencies?: SavedIssueSearchViewPersistenceDependencies,
}): Promise<void> {
  await deleteSavedIssueSearchView(options);
}

export type { SavedIssueSearchViewMutation };
