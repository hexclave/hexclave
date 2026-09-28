import "server-only";

import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { timingSafeEqual } from "node:crypto";

export const FEEDBACK_INGEST_SECRET_ENV = "HEXCLAVE_FEEDBACK_INGEST_SECRET";

function configuredSecret(): string {
  const secret = (process.env[FEEDBACK_INGEST_SECRET_ENV] ?? "").trim();
  if (secret === "") {
    throw new StatusError(
      StatusError.ServiceUnavailable,
      "Feedback ingest is not configured.",
    );
  }
  return secret;
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function requireFeedbackIngestSecret(req: Request): void {
  const expected = configuredSecret();
  const authorization = req.headers.get("authorization");
  if (authorization == null || !authorization.startsWith("Bearer ")) {
    throw new StatusError(StatusError.Unauthorized, "Missing feedback ingest credential.");
  }
  if (!secretsMatch(authorization.slice("Bearer ".length), expected)) {
    throw new StatusError(StatusError.Unauthorized, "Invalid feedback ingest credential.");
  }
}
