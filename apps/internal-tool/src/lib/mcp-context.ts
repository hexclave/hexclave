export const MCP_CONTEXT_NOT_PROVIDED = "(not provided)";

export function hasMcpContextValue(value: string): boolean {
  return value !== "" && value !== MCP_CONTEXT_NOT_PROVIDED;
}
