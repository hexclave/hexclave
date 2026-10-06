import {
  createSavedIssueSearchViewCreateRoute,
  createSavedIssueSearchViewListRoute,
} from "@/lib/issues/saved-search-views/route-handlers";
import { internalSavedIssueSearchViewRouteOptions } from "./_shared";

export const GET = createSavedIssueSearchViewListRoute(internalSavedIssueSearchViewRouteOptions);
export const POST = createSavedIssueSearchViewCreateRoute(internalSavedIssueSearchViewRouteOptions);
