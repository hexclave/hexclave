import "server-only";

import type { CurrentServerUser } from "@hexclave/next";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { getHexclaveServerApp } from "../../hexclave-server";

export type InternalAiChatReviewer = {
  user: CurrentServerUser,
  reviewerName: string,
};

// Any signed-in user of the tool's Stack Auth project is authorized: the
// project's sign-up rules restrict membership to the team. Server-side
// SpacetimeDB calls on the user's behalf use a token minted by
// `signSpacetimeToken` (see spacetimedb-token.ts), not the Stack Auth session
// token itself.
export async function requireInternalAiChatReviewer(req: Request): Promise<InternalAiChatReviewer> {
  const user = await getHexclaveServerApp().getUser({ tokenStore: req });
  if (user == null) {
    throw new StatusError(StatusError.Unauthorized, "You must be signed in to perform MCP review operations.");
  }

  return {
    user,
    reviewerName: user.displayName ?? user.primaryEmail ?? user.id,
  };
}
