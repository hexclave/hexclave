import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { createFeatureFlagsBootstrap } from "@hexclave/shared/dist/feature-flags/canonical";
import { evaluateFeatureFlag, findFeatureFlagIdByKey } from "@hexclave/shared/dist/feature-flags/evaluator";
import { parseFeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/schema";
import { isFeatureFlagValue, type FeatureFlagEvaluationContext, type FeatureFlagEvaluationResult, type FeatureFlagValue } from "@hexclave/shared/dist/feature-flags/types";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { withActiveExperimentRuns } from "@/lib/feature-flags/active-experiments";
import { createFeatureFlagEvaluationToken } from "@/lib/feature-flags/exposure-tokens";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { ensureTeamMembershipExists } from "@/lib/request-checks";

const MAX_FLAG_KEYS = 50;
const MAX_CONTEXT_PROPERTIES = 50;
const MAX_CONTEXT_BYTES = 16_384;

function hasAtMostProperties(value: object | null | undefined, maximum: number): boolean {
  return value == null || Object.keys(value).length <= maximum;
}

function hasAtMostEncodedBytes(value: unknown, maximum: number): boolean {
  return value == null || new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
}

const jsonValueSchema = yupMixed<Exclude<FeatureFlagValue, null>>()
  .nullable()
  .test("json", "Value must be JSON serializable", isFeatureFlagValue);

const boundedContextSchema = yupRecord(yupString().min(1).max(128), jsonValueSchema.optional())
  .test("context-properties", `Context may contain at most ${MAX_CONTEXT_PROPERTIES} properties`, (value) => hasAtMostProperties(value, MAX_CONTEXT_PROPERTIES))
  .test("context-size", `Context may contain at most ${MAX_CONTEXT_BYTES} bytes`, (value) => hasAtMostEncodedBytes(value, MAX_CONTEXT_BYTES));

const evaluationBodySchema = yupObject({
  flag_keys: yupArray(yupString().min(1).max(128).defined()).defined().min(1).max(MAX_FLAG_KEYS),
  fallbacks: yupRecord(yupString().min(1).max(128), jsonValueSchema.optional())
    .test("fallback-count", `Fallbacks may contain at most ${MAX_FLAG_KEYS} properties`, (value) => hasAtMostProperties(value, MAX_FLAG_KEYS))
    .test("fallback-size", `Fallbacks may contain at most ${MAX_CONTEXT_BYTES} bytes`, (value) => hasAtMostEncodedBytes(value, MAX_CONTEXT_BYTES))
    .optional(),
  distinct_id: yupString().min(1).max(256).optional(),
  user_id: yupString().min(1).max(256).optional(),
  team_id: yupString().min(1).max(256).optional(),
  context: boundedContextSchema.optional(),
  user: boundedContextSchema.optional(),
  team: boundedContextSchema.optional(),
  segments: yupRecord(yupString().min(1).max(128), yupBoolean().oneOf([true])).test("segment-count", "Segments may contain at most 100 properties", (value) => hasAtMostProperties(value, 100)).optional(),
});

const evaluationResultSchema = yupObject({
  flag_key: yupString().defined(),
  value: jsonValueSchema.defined(),
  variant_key: yupString().nullable().defined(),
  reason: yupString().oneOf(["missing", "archived", "killed", "disabled", "prerequisite_unmet", "dependency_cycle", "holdout", "mutual_exclusion", "matched_rule", "fallback"]).defined(),
  rule_id: yupString().nullable().defined(),
  config_version: yupString().defined(),
  experiment_id: yupString().nullable().defined(),
  experiment_run_id: yupString().nullable().defined(),
  exposure_token: yupString().nullable().defined(),
});

async function shapeResult(
  requestedKey: string,
  result: FeatureFlagEvaluationResult,
  fallback: FeatureFlagValue,
  configVersion: string,
  options: {
    auth: { tenancy: Parameters<typeof createFeatureFlagEvaluationToken>[0]["tenancy"] },
    config: ReturnType<typeof parseFeatureFlagsConfig>,
    context: FeatureFlagEvaluationContext,
  },
) {
  const experiment = result.experimentId === undefined ? undefined : options.config.experiments?.[result.experimentId];
  const subjectType = experiment?.assignmentUnit;
  const subjectId = subjectType === "team" ? options.context.teamId : options.context.userId;
  const exposureToken =
    result.reason === "matched_rule" &&
    result.variantKey !== undefined &&
    result.ruleId !== undefined &&
    result.experimentId !== undefined &&
    result.experimentRunId !== undefined &&
    result.experimentConfigRevision !== undefined &&
    subjectType !== undefined &&
    subjectId !== undefined
      ? (await createFeatureFlagEvaluationToken({
        tenancy: options.auth.tenancy,
        runId: result.experimentRunId,
        experimentId: result.experimentId,
        flagId: result.flagId,
        variantId: result.variantKey,
        ruleId: result.ruleId,
        reason: result.reason,
        configRevisionHash: result.experimentConfigRevision,
        subjectType,
        subjectId,
      })).token
      : null;
  return {
    flag_key: requestedKey,
    value: result.value === undefined ? fallback : result.value,
    variant_key: result.variantKey ?? null,
    reason: result.reason,
    rule_id: result.ruleId ?? null,
    config_version: configVersion,
    experiment_id: result.experimentId ?? null,
    experiment_run_id: result.experimentRunId ?? null,
    exposure_token: exposureToken,
  };
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Evaluate feature flags",
    description: "Evaluates requested public feature flag keys without exposing targeting definitions.",
    tags: ["Feature Flags"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema.optional(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
    body: evaluationBodySchema.defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      results: yupRecord(yupString(), evaluationResultSchema).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    if (auth.tenancy.config.apps.installed["feature-flags"]?.enabled !== true) {
      throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project.");
    }

    const config = await withActiveExperimentRuns(
      auth.tenancy,
      parseFeatureFlagsConfig(auth.tenancy.config.featureFlags),
    );
    const bootstrap = createFeatureFlagsBootstrap(config);
    const trustedCaller = auth.type !== "client";
    const verifiedEmail = auth.user?.primary_email_verified === true ? auth.user.primary_email ?? undefined : undefined;
    if (!trustedCaller && body.team_id !== undefined) {
      if (auth.user === undefined) {
        throw new StatusError(StatusError.BadRequest, "Selecting a team requires an authenticated or anonymous user identity.");
      }
      const prisma = await getPrismaClientForTenancy(auth.tenancy);
      await ensureTeamMembershipExists(prisma, {
        tenancyId: auth.tenancy.id,
        teamId: body.team_id,
        userId: auth.user.id,
      });
    }
    const selectedTeamId = body.team_id;
    const context: FeatureFlagEvaluationContext = trustedCaller ? {
      distinctId: body.distinct_id ?? body.user_id ?? auth.user?.id,
      userId: body.user_id ?? auth.user?.id,
      teamId: body.team_id,
      user: body.user,
      team: body.team,
      context: body.context,
      segments: new Set(Object.keys(body.segments ?? {})),
    } : {
      distinctId: auth.user?.id ?? body.distinct_id,
      userId: auth.user?.id,
      teamId: selectedTeamId,
      user: auth.user === undefined ? undefined : {
        id: auth.user.id,
        email: verifiedEmail,
        primary_email: verifiedEmail,
        primary_email_verified: auth.user.primary_email_verified,
        signedUpAt: new Date(auth.user.signed_up_at_millis).toISOString(),
      },
      team: selectedTeamId === undefined ? undefined : { id: selectedTeamId },
      // Context is first-party application data (locale, app version, plan
      // the app already computed). It is not a substitute for `user`/`team`,
      // which are stripped here. Operators must not treat `context.*` rules
      // as an authorization boundary.
      context: body.context,
    };

    const results = new Map<string, Awaited<ReturnType<typeof shapeResult>>>();
    for (const requestedKey of body.flag_keys) {
      const fallback = body.fallbacks?.[requestedKey] ?? null;
      const flagId = findFeatureFlagIdByKey(config, requestedKey);
      const evaluated = flagId === undefined
        ? { flagId: requestedKey, flagKey: requestedKey, reason: "missing" } satisfies FeatureFlagEvaluationResult
        : evaluateFeatureFlag(flagId, config, context);
      results.set(requestedKey, await shapeResult(requestedKey, evaluated, fallback, bootstrap.configVersion, { auth, config, context }));
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: { results: Object.fromEntries(results) },
    };
  },
});
