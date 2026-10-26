import { StatusError } from "@hexclave/shared/dist/utils/errors";

export function readTvDisplayBearerToken(value: string | undefined): string {
  if (value == null || value.slice(0, "Bearer ".length).toLowerCase() !== "bearer ") {
    throw new StatusError(401, "tv_display_access_required");
  }
  // An empty or whitespace-led token is a malformed credential rather than a
  // rejected one, so it must fail the same way a missing header does.
  const token = value.slice("Bearer ".length);
  if (token === "" || /^\s/.test(token)) {
    throw new StatusError(401, "tv_display_access_required");
  }
  return token;
}
