import {
  createSavedIssueSearchViewCreateRoute,
  createSavedIssueSearchViewListRoute,
} from "@/lib/issues/saved-search-views/route-handlers";
import { publicSavedIssueSearchViewRouteOptions } from "./_shared";

export const GET = createSavedIssueSearchViewListRoute(publicSavedIssueSearchViewRouteOptions);
export const POST = createSavedIssueSearchViewCreateRoute(publicSavedIssueSearchViewRouteOptions);
