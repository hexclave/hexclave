import type { SavedIssueSearchViewRouteHandlerOptions } from "@/lib/issues/saved-search-views/route-handlers";
import {
  clientOrHigherAuthTypeSchema,
  serverOrHigherAuthTypeSchema,
} from "@hexclave/shared/dist/schema-fields";

export const publicSavedIssueSearchViewRouteOptions: SavedIssueSearchViewRouteHandlerOptions = {
  authTypeSchema: serverOrHigherAuthTypeSchema,
  mutationAuthTypeSchema: clientOrHigherAuthTypeSchema,
  metadata: {
    list: {
      summary: "List saved issue search views",
      description: "Lists bounded saved issue-search filters visible in the authenticated project branch. Private views are returned only to their owner; project views are branch-scoped.",
      tags: ["Issues"],
    },
    create: {
      summary: "Create a saved issue search view",
      description: "Creates a versioned, bounded saved issue-search filter in the authenticated project branch. The body cannot provide tenancy, project, branch, or owner identifiers.",
      tags: ["Issues"],
    },
    get: {
      summary: "Get a saved issue search view",
      description: "Returns one saved issue-search filter only when it is visible in the authenticated project branch.",
      tags: ["Issues"],
    },
    update: {
      summary: "Update a saved issue search view",
      description: "Updates a saved issue-search filter only when the authenticated user owns it or the caller has explicit admin access.",
      tags: ["Issues"],
    },
    delete: {
      summary: "Delete a saved issue search view",
      description: "Deletes a saved issue-search filter only when the authenticated user owns it or the caller has explicit admin access.",
      tags: ["Issues"],
    },
  },
};
