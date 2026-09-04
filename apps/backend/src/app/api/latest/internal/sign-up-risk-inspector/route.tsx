// Platform-admin diagnostic tool. Supplied IP addresses are treated as trusted
// because the admin is asserting them; stats-based signals fall back to the
// internal project's own sign-ups only when no IP is given.

import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { calculateSignUpRiskAssessment, signUpRiskSignalIds } from "@/lib/risk-scores";
import { getDerivedSignUpCountryCode } from "@/lib/users";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { riskScoreFieldSchema } from "@hexclave/shared/dist/interface/crud/users";
import { adaptSchema, clientOrHigherAuthTypeSchema, countryCodeSchema, emailSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isIpAddress } from "@hexclave/shared/dist/utils/ips";
import { INTERNAL_PROJECT_ID } from "../newly-created-projects/helpers";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }),
    body: yupObject({
      entries: yupArray(yupObject({
        email: emailSchema.defined(),
        ip_address: yupString()
          .test("is-ip", "must be an IP address", (value) => value == null || isIpAddress(value))
          .nullable()
          .optional(),
        country_code: countryCodeSchema.nullable().optional(),
      }).defined()).min(1).max(50).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      results: yupArray(yupObject({
        email: emailSchema.defined(),
        ip_address: yupString().nullable().defined(),
        country_code: yupString().nullable().defined(),
        scores: yupObject({
          bot: riskScoreFieldSchema,
          free_trial_abuse: riskScoreFieldSchema,
        }).defined(),
        heuristic_facts: yupObject({
          email_normalized: yupString().nullable().defined(),
          email_base: yupString().nullable().defined(),
        }).defined(),
        breakdown: yupArray(yupObject({
          signal: yupString().oneOf(signUpRiskSignalIds).defined(),
          factor: yupObject({
            bot: yupNumber().min(0).max(1).defined(),
            free_trial_abuse: yupNumber().min(0).max(1).defined(),
          }).defined(),
          details: yupMixed<Record<string, Json>>().defined(),
        }).defined()).defined(),
      }).defined()).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    if (!req.auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (req.auth.project.id !== INTERNAL_PROJECT_ID) {
      throw new KnownErrors.ExpectedInternalProject();
    }
    await ensurePlatformAdmin(req.auth.user);

    const entries = req.body.entries.map((entry) => ({
      email: entry.email.trim().toLowerCase(),
      ipAddress: entry.ip_address ?? null,
      countryCode: entry.country_code ?? null,
    })).filter((entry, index, allEntries) => allEntries.findIndex((candidate) =>
      candidate.email === entry.email &&
      candidate.ipAddress === entry.ipAddress &&
      candidate.countryCode === entry.countryCode
    ) === index);
    const results = await Promise.all(entries.map(async (entry) => {
      const countryCode = getDerivedSignUpCountryCode(entry.countryCode, entry.email);
      const assessment = await calculateSignUpRiskAssessment(req.auth.tenancy, {
        primaryEmail: entry.email,
        primaryEmailVerified: false,
        authMethod: "password",
        oauthProvider: null,
        ipAddress: entry.ipAddress,
        ipTrusted: entry.ipAddress != null ? true : null,
        countryCode,
        oauthAccountCreatedAtMillis: null,
        turnstileAssessment: { status: "ok" },
      });
      return {
        email: entry.email,
        ip_address: entry.ipAddress,
        country_code: countryCode,
        scores: {
          bot: assessment.scores.bot,
          free_trial_abuse: assessment.scores.free_trial_abuse,
        },
        heuristic_facts: {
          email_normalized: assessment.heuristicFacts.emailNormalized,
          email_base: assessment.heuristicFacts.emailBase,
        },
        breakdown: assessment.breakdown,
      };
    }));

    return {
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: { results },
    };
  },
});
