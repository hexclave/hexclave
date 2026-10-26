import "server-only";

import type { CurrentServerUser } from "@hexclave/next";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { getHexclaveServerApp } from "../../hexclave-server";
import { isAiChatReviewer } from "../ai-chat-reviewer";

export type InternalAiChatReviewer = {
  user: CurrentServerUser,
  reviewerName: string,
};

// This is the only gate in front of minting user SpacetimeDB tokens (see
// spacetimedb-token.ts): the SpacetimeDB module trusts any token signed by the
// internal tool, so every route that calls `signSpacetimeToken` for a user must
// go through here first.
export async function requireInternalAiChatReviewer(req: Request): Promise<InternalAiChatReviewer> {
  const user = await getHexclaveServerApp().getUser({ tokenStore: req });
  if (user == null) {
    throw new StatusError(StatusError.Unauthorized, "You must be signed in to perform MCP review operations.");
  }
  if (!isAiChatReviewer(user.clientReadOnlyMetadata)) {
    throw new StatusError(StatusError.Forbidden, "You are not approved to perform MCP review operations.");
  }

  return {
    user,
    reviewerName: user.displayName ?? user.primaryEmail ?? user.id,
  };
}
