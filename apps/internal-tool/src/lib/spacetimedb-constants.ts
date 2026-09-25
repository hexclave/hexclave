const PLACEHOLDER = "REPLACE_ME";

export const DEFAULT_SPACETIMEDB_DB_NAME = "hexclave-ai-analytics";
export function spacetimeDbName(): string {
  const value = process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME?.trim();
  if (value == null || value === "" || value === PLACEHOLDER) {
    return DEFAULT_SPACETIMEDB_DB_NAME;
  }
  return value;
}

export const SPACETIMEDB_TOKEN_AUDIENCE = "spacetimedb";
