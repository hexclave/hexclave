import type { Tenancy } from "@/lib/tenancies";
import { yupObject, yupString, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { signJWT, verifyJWT } from "@hexclave/shared/dist/utils/jwt";
import { JOSEError } from "jose/errors";
import { createHash } from "node:crypto";
import { ValidationError } from "yup";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";

/**
 * Signed evaluation tokens for feature-flag exposures.
 *
 * When a flag is evaluated for a subject, the evaluation endpoint mints one of
 * these tokens and returns it alongside the flag value. The client later posts
 * it back through POST /api/latest/feature-flags/exposures/batch to record the
 * exposure. Because the token binds tenancy + subject + flag + variant +
 * config revision + run and is signed server-side, a client cannot fabricate
 * exposures for other subjects/variants/projects or replay exposures into a
 * different experiment revision — the worst it can do is re-send its own
 * token, which ingestion dedupes by event id.
 */

const EXPOSURE_TOKEN_ISSUER = "hexclave:feature-flags:evaluation";
const EXPOSURE_TOKEN_AUDIENCE = "hexclave:feature-flags:exposures";
const EXPOSURE_TOKEN_KIND = "feature_flag_evaluation";
// Short-lived: an exposure should be reported promptly after evaluation (the
// SDK batches on the order of seconds). 30 minutes tolerates offline queues
// and clock skew without leaving a long-lived replayable credential around.
export const EXPOSURE_TOKEN_TTL_MS = 30 * 60 * 1000;

const FeatureFlagExposureTokenPayloadSchema = yupObject({
  kind: yupString().oneOf([EXPOSURE_TOKEN_KIND]).defined(),
  evaluation_id: yupString().uuid().defined(),
  issued_at_millis: yupString().matches(/^\d+$/).defined(),
  project_id: yupString().defined(),
  branch_id: yupString().defined(),
  run_id: yupString().defined(),
  experiment_id: yupString().defined(),
  flag_id: yupString().defined(),
  variant_id: yupString().defined(),
  rule_id: yupString().defined(),
  reason: yupString().defined(),
  config_revision_hash: yupString().defined(),
  subject_type: yupString().oneOf(["user", "team"]).defined(),
  subject_id: yupString().defined(),
  subject_hash: yupString().defined(),
}).defined();

export type FeatureFlagExposureTokenPayload = {
  kind: typeof EXPOSURE_TOKEN_KIND,
  evaluation_id: string,
  issued_at_millis: string,
  project_id: string,
  branch_id: string,
  run_id: string,
  experiment_id: string,
  flag_id: string,
  variant_id: string,
  rule_id: string,
  reason: string,
  config_revision_hash: string,
  subject_type: "user" | "team",
  subject_id: string,
  subject_hash: string,
};

/**
 * Project-scoped pseudonymous subject identifier stored in ClickHouse instead
 * of the raw user/team id, scoped by project + subject type so the same user
 * id in two projects (or a user id colliding with a team id) never produces
 * the same hash.
 *
 * Deliberately NOT salted with a secret: experiment attribution joins exposure
 * rows against conversion events by recomputing this hash from events.user_id
 * *inside* ClickHouse (see experiment-results.ts), so the formula must be
 * reproducible there without shipping a secret into query text or params. The
 * hash provides scope separation and pseudonymity at rest, not secrecy against
 * an attacker who already holds both the subject ids and table access.
 * Formula (must stay in sync with the SQL in experiment-results.ts):
 *   lowercase hex sha256 of "hexclave:ff:subject:<projectId>:<subjectType>:<subjectId>"
 */
export function computeExposureSubjectHash(options: {
  projectId: string,
  subjectType: "user" | "team",
  subjectId: string,
}): string {
  const input = `hexclave:ff:subject:${options.projectId}:${options.subjectType}:${options.subjectId}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function createFeatureFlagEvaluationToken(options: {
  tenancy: Tenancy,
  runId: string,
  experimentId: string,
  flagId: string,
  variantId: string,
  ruleId: string,
  reason: string,
  configRevisionHash: string,
  subjectType: "user" | "team",
  subjectId: string,
}): Promise<{ token: string, expiresAtMillis: number }> {
  const issuedAtMillis = Date.now();
  const expiresAtMillis = issuedAtMillis + EXPOSURE_TOKEN_TTL_MS;
  const token = await signJWT({
    issuer: EXPOSURE_TOKEN_ISSUER,
    audience: EXPOSURE_TOKEN_AUDIENCE,
    expirationTime: `${EXPOSURE_TOKEN_TTL_MS / 1000}s`,
    payload: {
      kind: EXPOSURE_TOKEN_KIND,
      evaluation_id: generateUuid(),
      issued_at_millis: issuedAtMillis.toString(),
      project_id: options.tenancy.project.id,
      branch_id: options.tenancy.branchId,
      run_id: options.runId,
      experiment_id: options.experimentId,
      flag_id: options.flagId,
      variant_id: options.variantId,
      rule_id: options.ruleId,
      reason: options.reason,
      config_revision_hash: options.configRevisionHash,
      subject_type: options.subjectType,
      subject_id: options.subjectId,
      subject_hash: computeExposureSubjectHash({
        projectId: options.tenancy.project.id,
        subjectType: options.subjectType,
        subjectId: options.subjectId,
      }),
    } satisfies FeatureFlagExposureTokenPayload,
  });
  return { token, expiresAtMillis };
}

/**
 * Verifies an evaluation token for exposure ingestion. Tampered, expired, or
 * otherwise invalid tokens fail with 401; a validly-signed token minted for a
 * different project/branch than the authenticated tenancy fails with 403.
 * Error messages are deliberately generic — they must not reveal which part of
 * a forged token failed verification.
 */
export async function verifyFeatureFlagEvaluationToken(options: {
  token: string,
  tenancy: Tenancy,
}): Promise<FeatureFlagExposureTokenPayload> {
  let payload: FeatureFlagExposureTokenPayload;
  try {
    const verified = await verifyJWT({ allowedIssuers: [EXPOSURE_TOKEN_ISSUER], jwt: options.token });
    // verifyJWT only constrains the issuer, so also require the audience to
    // match — otherwise a validly-signed token minted for a different audience
    // could pass. (Same pattern as analytics-clickmap-tokens.ts.)
    if (verified.aud !== EXPOSURE_TOKEN_AUDIENCE) {
      throw new StatusError(StatusError.Unauthorized, "Invalid or expired feature flag evaluation token");
    }
    payload = await yupValidate(FeatureFlagExposureTokenPayloadSchema, verified, { abortEarly: false });
  } catch (error) {
    // Only expected JWT/validation failures are auth errors; rethrow anything
    // unexpected (e.g. backend faults) so they aren't misreported as bad credentials.
    if (error instanceof StatusError) throw error;
    if (error instanceof JOSEError || error instanceof ValidationError) {
      throw new StatusError(StatusError.Unauthorized, "Invalid or expired feature flag evaluation token");
    }
    throw error;
  }

  if (payload.project_id !== options.tenancy.project.id || payload.branch_id !== options.tenancy.branchId) {
    throw new StatusError(StatusError.Forbidden, "Feature flag evaluation token does not belong to this project");
  }
  return payload;
}
