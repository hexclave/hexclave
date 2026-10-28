import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { FreePageReleaseConflictError } from "./databases/piledriver/implementations/breezy/core.js";

export type ReleaseFreePagesOptions = { maxBytes: number, dryRun: boolean };

/** Without a limit, one request gives back at most this much, so it finishes in seconds. */
export const defaultReleaseFreePagesMaxBytes = 1024 * 1024 * 1024;
const minReleaseFreePagesMaxBytes = 1024 * 1024;

/**
 * Validates a POST /internal/piledriver-release-free-pages body and runs the release. `release` is
 * null when the service's backend can't release free pages.
 */
export async function handleReleaseFreePagesRequest<Result>(
  body: unknown,
  release: ((options: ReleaseFreePagesOptions) => Promise<Result>) | null,
  backend: string,
): Promise<Result> {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
    throw new StatusError(StatusError.BadRequest, "Expected JSON object body");
  }
  const requestBody = body ?? {};
  const requestedMaxBytes: unknown = Reflect.get(requestBody, "maxBytes");
  const maxBytes = requestedMaxBytes === undefined ? defaultReleaseFreePagesMaxBytes : requestedMaxBytes;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new StatusError(StatusError.BadRequest, "maxBytes must be a positive safe integer");
  }
  // SQLite pages are at most 64 KiB, so a smaller limit could release nothing while reporting that
  // the limit was reached, and a caller repeating "until done" would stop without releasing anything.
  if (maxBytes < minReleaseFreePagesMaxBytes) throw new StatusError(StatusError.BadRequest, "maxBytes must be at least 1 MiB");
  const requestedDryRun: unknown = Reflect.get(requestBody, "dryRun");
  const dryRun = requestedDryRun === undefined ? false : requestedDryRun;
  if (typeof dryRun !== "boolean") throw new StatusError(StatusError.BadRequest, "dryRun must be a boolean");
  if (dryRun && requestedMaxBytes !== undefined) throw new StatusError(StatusError.BadRequest, "maxBytes can't be combined with dryRun, which releases nothing");
  if (release === null) {
    throw new StatusError(StatusError.BadRequest, `Releasing free pages is only supported on the breezylite backend (current: ${backend})`);
  }
  try {
    return await release({ maxBytes, dryRun });
  } catch (error) {
    if (error instanceof FreePageReleaseConflictError) throw new StatusError(StatusError.Conflict, error.message);
    throw error;
  }
}
