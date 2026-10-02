import {
  createSavedIssueSearchViewDeleteRoute,
  createSavedIssueSearchViewGetRoute,
  createSavedIssueSearchViewUpdateRoute,
} from "@/lib/issues/saved-search-views/route-handlers";
import { publicSavedIssueSearchViewRouteOptions } from "../_shared";

export const GET = createSavedIssueSearchViewGetRoute(publicSavedIssueSearchViewRouteOptions);
export const PUT = createSavedIssueSearchViewUpdateRoute(publicSavedIssueSearchViewRouteOptions);
export const DELETE = createSavedIssueSearchViewDeleteRoute(publicSavedIssueSearchViewRouteOptions);
