// Authorization for the internal tool. Being signed in to the tool's Hexclave
// project is NOT sufficient: the tool may run against the shared "internal"
// project (it does by default in development), whose publishable client key is
// public and which anyone can sign up to via the dashboard. Reviewers must
// instead be explicitly approved by setting `isAiChatReviewer: true` in their
// client read-only metadata, which users cannot write themselves.
//
// Shared between the server gate (`requireInternalAiChatReviewer`) and the UI so
// both agree on who is a reviewer; only the server check is load-bearing.
export function isAiChatReviewer(clientReadOnlyMetadata: unknown): boolean {
  return typeof clientReadOnlyMetadata === "object"
    && clientReadOnlyMetadata != null
    && "isAiChatReviewer" in clientReadOnlyMetadata
    && clientReadOnlyMetadata.isAiChatReviewer === true;
}
