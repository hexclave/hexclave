
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_REGEX = /^\d+$/;
const HEX_ID_REGEX = /^[0-9a-f]{8,}$/i;
const BASE64_TOKEN_REGEX = /^[A-Za-z0-9_-]{16,}[=]{0,2}$/;
const PREFIXED_ID_REGEX = /^[a-z]{1,10}_[a-z0-9]*\d[a-z0-9]*$/i;

function isLikelyDynamicSegment(segment: string): boolean {
  if (segment.length === 0) return false;

  if (UUID_REGEX.test(segment)) return true;
  if (NUMERIC_REGEX.test(segment)) return true;
  if (HEX_ID_REGEX.test(segment)) return true;
  if (PREFIXED_ID_REGEX.test(segment)) return true;

  if (/\d/u.test(segment) && BASE64_TOKEN_REGEX.test(segment)) return true;

  return false;
}

export function normalizeUrlPath(path: string): string {
  const queryStart = path.indexOf("?");
  const hashStart = path.indexOf("#");
  const end = Math.min(
    queryStart < 0 ? path.length : queryStart,
    hashStart < 0 ? path.length : hashStart,
  );
  const cleanPath = path.slice(0, end);

  const segments = cleanPath.split("/");
  const normalized = segments.map((seg) =>
    isLikelyDynamicSegment(seg) ? ":id" : seg
  );

  return normalized.join("/") || "/";
}
