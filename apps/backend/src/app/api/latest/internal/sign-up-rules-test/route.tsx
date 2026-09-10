import { createSignUpRuleContext } from "@/lib/cel-evaluator";
import { getBestEffortEndUserRequestContext } from "@/lib/end-users";
import { calculateSignUpRiskScores } from "@/lib/risk-scores";
import { evaluateSignUpRulesWithTrace } from "@/lib/sign-up-rules";
import { getDerivedSignUpCountryCode } from "@/lib/users";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { riskScoreFieldSchema } from "@hexclave/shared/dist/interface/crud/users";
import { signUpAuthMethodValues } from "@hexclave/shared/dist/utils/auth-methods";
import type { TurnstileResult } from "@hexclave/shared/dist/utils/turnstile";
import { turnstileResultValues } from "@hexclave/shared/dist/utils/turnstile";
import { adaptSchema, adminAuthTypeSchema, countryCodeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const ACTION_TYPES = ['allow', 'reject', 'restrict', 'log'] as const;
const DECISION_TYPES = ['allow', 'reject', 'default-allow', 'default-reject'] as const;
const STATUS_TYPES = ['matched', 'not_matched', 'disabled', 'missing_condition', 'error'] as const;

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }),
    body: yupObject({
      email: yupString().nullable().defined(),
      auth_method: yupString().oneOf(signUpAuthMethodValues).defined(),
      oauth_provider: yupString().nullable().defined(),
      country_code: countryCodeSchema.nullable().defined(),
      turnstile_result: yupString().oneOf(["ok", "invalid", "error"]).optional(),
      risk_scores: yupObject({
        bot: riskScoreFieldSchema,
        free_trial_abuse: riskScoreFieldSchema,
      }).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      context: yupObject({
        email: yupString().defined(),
        email_domain: yupString().defined(),
        country_code: yupString().defined(),
        auth_method: yupString().oneOf(signUpAuthMethodValues).defined(),
        oauth_provider: yupString().defined(),
        turnstile_result: yupString().oneOf(turnstileResultValues).defined(),
        risk_scores: yupObject({
          bot: riskScoreFieldSchema,
          free_trial_abuse: riskScoreFieldSchema,
        }).defined(),
      }).defined(),
      evaluations: yupArray(yupObject({
        rule_id: yupString().defined(),
        display_name: yupString().defined(),
        enabled: yupBoolean().defined(),
        condition: yupString().defined(),
        status: yupString().oneOf(STATUS_TYPES).defined(),
        action: yupObject({
          type: yupString().oneOf(ACTION_TYPES).defined(),
          message: yupString().optional(),
        }).defined(),
        error: yupString().optional(),
      }).defined()).defined(),
      outcome: yupObject({
        should_allow: yupBoolean().defined(),
        decision: yupString().oneOf(DECISION_TYPES).defined(),
        decision_rule_id: yupString().nullable().defined(),
        restricted_because_of_rule_id: yupString().nullable().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    const endUserRequestContext = await getBestEffortEndUserRequestContext();
    const derivedCountryCode = getDerivedSignUpCountryCode(endUserRequestContext.location?.countryCode ?? null, req.body.email);
    const normalizedTurnstileResult: TurnstileResult = req.body.turnstile_result ?? "invalid";
    const derivedRiskScores = await calculateSignUpRiskScores(req.auth.tenancy, {
      primaryEmail: req.body.email,
      primaryEmailVerified: req.body.auth_method === "otp",
      authMethod: req.body.auth_method,
      oauthProvider: req.body.oauth_provider,
      ipAddress: endUserRequestContext.ipAddress,
      ipTrusted: endUserRequestContext.ipTrusted,
      countryCode: req.body.country_code ?? derivedCountryCode,
      oauthAccountCreatedAtMillis: null,
      turnstileAssessment: {
        status: normalizedTurnstileResult,
      },
    });
    const riskScores = req.body.risk_scores === undefined
      ? derivedRiskScores
      : req.body.risk_scores;
    const context = createSignUpRuleContext({
      email: req.body.email,
      countryCode: req.body.country_code ?? derivedCountryCode,
      authMethod: req.body.auth_method,
      oauthProvider: req.body.oauth_provider,
      riskScores,
    });
    const trace = evaluateSignUpRulesWithTrace(req.auth.tenancy, context);

    return {
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: {
        context: {
          email: context.email,
          email_domain: context.emailDomain,
          country_code: context.countryCode,
          auth_method: context.authMethod,
          oauth_provider: context.oauthProvider,
          turnstile_result: normalizedTurnstileResult,
          risk_scores: {
            bot: context.riskScores.bot,
            free_trial_abuse: context.riskScores.free_trial_abuse,
          },
        },
        evaluations: trace.evaluations.map((evaluation) => ({
          rule_id: evaluation.ruleId,
          display_name: evaluation.rule.displayName ?? "",
          enabled: evaluation.rule.enabled !== false,
          condition: evaluation.rule.condition ?? "",
          status: evaluation.status,
          action: {
            type: evaluation.rule.action.type,
            message: evaluation.rule.action.message,
          },
          ...(evaluation.error ? { error: evaluation.error } : {}),
        })),
        outcome: {
          should_allow: trace.outcome.shouldAllow,
          decision: trace.outcome.decision,
          decision_rule_id: trace.outcome.decisionRuleId,
          restricted_because_of_rule_id: trace.outcome.restrictedBecauseOfSignUpRuleId,
        },
      },
    };
  },
});
