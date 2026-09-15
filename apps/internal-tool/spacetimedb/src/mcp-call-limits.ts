/**
 * Upper bounds for the caller-supplied MCP call metadata. `user` and `project` are identifiers
 * (an email, a project name); `context` is the caller's free-text description of what it was
 * doing. Both the ingest route and the `log_mcp_call` reducer enforce these so a single oversized
 * field can neither grow the log unboundedly nor slip in through a direct reducer call.
 * The backend's request schema (apps/backend/src/lib/ai/schema.ts) applies the same caps.
 */
export const MAX_MCP_ACTOR_FIELD_LENGTH = 256;
export const MAX_MCP_CONTEXT_LENGTH = 2_000;
