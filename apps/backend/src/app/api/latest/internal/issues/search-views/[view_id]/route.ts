import {
  createSavedIssueSearchViewDeleteRoute,
  createSavedIssueSearchViewGetRoute,
  createSavedIssueSearchViewUpdateRoute,
} from "@/lib/issues/saved-search-views/route-handlers";
import { internalSavedIssueSearchViewRouteOptions } from "../_shared";

export const GET = createSavedIssueSearchViewGetRoute(internalSavedIssueSearchViewRouteOptions);
export const PUT = createSavedIssueSearchViewUpdateRoute(internalSavedIssueSearchViewRouteOptions);
export const DELETE = createSavedIssueSearchViewDeleteRoute(internalSavedIssueSearchViewRouteOptions);
