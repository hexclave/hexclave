/**
 * Normalize a URL path by replacing dynamic segments (UUIDs, numeric IDs,
 * hashes, base64 tokens, etc.) with placeholder tokens. This groups
 * similar pages (e.g. /users/abc123 and /users/def456 → /users/:id).
 */

// UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Purely numeric segments (e.g. /posts/12345)
const NUMERIC_REGEX = /^\d+$/;

// Long hex strings (8+ chars) — likely IDs or hashes
const HEX_ID_REGEX = /^[0-9a-f]{8,}$/i;

// Base64-like tokens (16+ chars of alphanumeric + padding chars)
const BASE64_TOKEN_REGEX = /^[A-Za-z0-9_-]{16,}[=]{0,2}$/;

// MongoDB ObjectIDs (24 hex chars)
const OBJECTID_REGEX = /^[0-9a-f]{24}$/i;

// Short numeric-heavy mixed IDs (e.g. "a1b2c3d4", "usr_abc123")
// Require at least one digit in the suffix to avoid matching static words like "sign_in"
const PREFIXED_ID_REGEX = /^[a-z]{1,10}_[a-z0-9]*\d[a-z0-9]*$/i;

function isLikelyDynamicSegment(segment: string): boolean {
  if (segment.length === 0) return false;

  // Check each pattern from most specific to least
  if (UUID_REGEX.test(segment)) return true;
  if (OBJECTID_REGEX.test(segment)) return true;
  if (NUMERIC_REGEX.test(segment)) return true;
  if (HEX_ID_REGEX.test(segment)) return true;
  if (PREFIXED_ID_REGEX.test(segment)) return true;

  // Base64 tokens (only for longer segments to avoid false positives on
  // short path segments like "api" or "auth")
  if (segment.length >= 20 && BASE64_TOKEN_REGEX.test(segment)) return true;

  return false;
}

export function normalizeUrlPath(path: string): string {
  // Strip query string and hash
  const cleanPath = path.split("?")[0]!.split("#")[0]!;

  const segments = cleanPath.split("/");
  const normalized = segments.map((seg) =>
    isLikelyDynamicSegment(seg) ? ":id" : seg
  );

  // Collapse consecutive :id segments (e.g. /a/:id/:id → /a/:id)
  const collapsed: string[] = [];
  for (const seg of normalized) {
    if (seg === ":id" && collapsed[collapsed.length - 1] === ":id") continue;
    collapsed.push(seg);
  }

  return collapsed.join("/") || "/";
}
