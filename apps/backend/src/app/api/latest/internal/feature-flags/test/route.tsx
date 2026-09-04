import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { createFeatureFlagsBootstrap } from "@hexclave/shared/dist/feature-flags/canonical";
import { evaluateFeatureFlag, findFeatureFlagIdByKey } from "@hexclave/shared/dist/feature-flags/evaluator";
import { parseFeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/schema";
import { isFeatureFlagValue, type FeatureFlagEvaluationContext, type FeatureFlagEvaluationResult, type FeatureFlagValue } from "@hexclave/shared/dist/feature-flags/types";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { withActiveExperimentRuns } from "@/lib/feature-flags/active-experiments";

function hasAtMostProperties(value: object | null | undefined, maximum: number): boolean {
  return value == null || Object.keys(value).length <= maximum;
}

function hasAtMostEncodedBytes(value: unknown, maximum: number): boolean {
  return value == null || new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
}

const jsonValueSchema = yupMixed<Exclude<FeatureFlagValue, null>>().nullable().test("json", "Value must be JSON serializable", isFeatureFlagValue);
const contextSchema = yupRecord(yupString().min(1).max(128), jsonValueSchema.optional())
  .test("bounded", "Context may contain at most 50 properties", (value) => hasAtMostProperties(value, 50))
  .test("size", "Context may contain at most 16384 bytes", (value) => hasAtMostEncodedBytes(value, 16_384));
const resultSchema = yupObject({
  flag_key: yupString().defined(), value: jsonValueSchema.defined(), variant_key: yupString().nullable().defined(), reason: yupString().defined(),
  rule_id: yupString().nullable().defined(), config_version: yupString().defined(), experiment_id: yupString().nullable().defined(), experiment_run_id: yupString().nullable().defined(), exposure_token: yupString().nullable().defined(),
});

export const POST = createSmartRouteHandler({
  metadata: { summary: "Test feature flag evaluation", tags: ["Feature Flags"], hidden: true },
  request: yupObject({
    auth: yupObject({ type: adminAuthTypeSchema.defined(), tenancy: adaptSchema.defined() }).defined(),
    body: yupObject({
      flag_keys: yupArray(yupString().min(1).max(128).defined()).defined().min(1).max(50),
      fallbacks: yupRecord(yupString().min(1).max(128), jsonValueSchema.optional()).optional(),
      distinct_id: yupString().min(1).max(256).optional(), user_id: yupString().min(1).max(256).optional(), team_id: yupString().min(1).max(256).optional(),
      context: contextSchema.optional(), user: contextSchema.optional(), team: contextSchema.optional(),
      segments: yupRecord(yupString().min(1).max(128), yupBoolean().oneOf([true])).test("bounded", "Segments may contain at most 100 properties", (value) => hasAtMostProperties(value, 100)).optional(),
    }).defined(),
  }),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: yupObject({ results: yupRecord(yupString(), resultSchema).defined() }).defined() }),
  handler: async ({ auth, body }) => {
    if (auth.tenancy.config.apps.installed["feature-flags"]?.enabled !== true) throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project.");
    const config = await withActiveExperimentRuns(
      auth.tenancy,
      parseFeatureFlagsConfig(auth.tenancy.config.featureFlags),
    );
    const version = createFeatureFlagsBootstrap(config).configVersion;
    const context: FeatureFlagEvaluationContext = { distinctId: body.distinct_id ?? body.user_id, userId: body.user_id, teamId: body.team_id, context: body.context, user: body.user, team: body.team, segments: new Set(Object.keys(body.segments ?? {})) };
    const results = new Map<string, {
      flag_key: string, value: FeatureFlagValue, variant_key: string | null, reason: FeatureFlagEvaluationResult["reason"], rule_id: string | null,
      config_version: string, experiment_id: string | null, experiment_run_id: string | null, exposure_token: null,
    }>();
    for (const key of body.flag_keys) {
      const fallback = body.fallbacks?.[key] ?? null;
      const flagId = findFeatureFlagIdByKey(config, key);
      const evaluated = flagId === undefined ? { flagId: key, flagKey: key, reason: "missing" } satisfies FeatureFlagEvaluationResult : evaluateFeatureFlag(flagId, config, context);
      results.set(key, { flag_key: key, value: evaluated.value === undefined ? fallback : evaluated.value, variant_key: evaluated.variantKey ?? null, reason: evaluated.reason, rule_id: evaluated.ruleId ?? null, config_version: version, experiment_id: evaluated.experimentId ?? null, experiment_run_id: evaluated.experimentRunId ?? null, exposure_token: null });
    }
    return { statusCode: 200, bodyType: "json", body: { results: Object.fromEntries(results) } };
  },
});
