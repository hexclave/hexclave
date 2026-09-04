import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import { signUpRiskEngine } from "@/private";
import type { SignUpRiskScoresCrud } from "@hexclave/shared/dist/interface/crud/users";
import type { SignUpAuthMethod } from "@hexclave/shared/dist/utils/auth-methods";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { checkEmailWithEmailable } from "./emailable";
import { type DerivedSignUpHeuristicFacts } from "./sign-up-heuristics";
import type { Tenancy } from "./tenancies";
import type { SignUpTurnstileAssessment } from "./turnstile";


// -- Types -------------------------------------------------------------------

export type SignUpRiskScores = SignUpRiskScoresCrud;

export type SignUpRiskScoreContext = {
  primaryEmail: string | null,
  primaryEmailVerified: boolean,
  authMethod: SignUpAuthMethod,
  oauthProvider: string | null,
  ipAddress: string | null,
  ipTrusted: boolean | null,
  countryCode?: string | null,
  oauthAccountCreatedAtMillis?: number | null,
  turnstileAssessment: SignUpTurnstileAssessment,
};

export const signUpRiskSignalIds = ["emailable", "same_ip", "same_email", "similar_email", "turnstile", "blacklist", "country", "public_email_provider", "connected_account_age"] as const;
export type SignUpRiskSignalId = typeof signUpRiskSignalIds[number];
export type SignUpRiskFactor = {
  bot: number,
  free_trial_abuse: number,
};

/** Per-signal probability before multiplicative combination, so the UI can attribute the final score. */
export type SignUpRiskSignalBreakdown = {
  signal: SignUpRiskSignalId,
  factor: SignUpRiskFactor,
  details: Record<string, Json>,
};

export type SignUpRiskAssessment = {
  scores: SignUpRiskScores,
  heuristicFacts: DerivedSignUpHeuristicFacts,
  breakdown: SignUpRiskSignalBreakdown[],
};

export type SignUpRiskRecentStatsRequest = {
  signedUpAt: Date,
  signUpIp: string | null,
  signUpEmailNormalized: string | null,
  signUpEmailBase: string | null,
  recentWindowHours: number,
  sameIpLimit: number,
  sameEmailLimit: number,
  similarEmailLimit: number,
};

export type SignUpRiskRecentStats = {
  sameIpCount: number,
  sameEmailCount: number,
  similarEmailCount: number,
};

export type SignUpRiskEngineDependencies = {
  checkPrimaryEmailRisk: (email: string) => Promise<{ emailableScore: number | null }>,
  loadRecentSignUpStats: (request: SignUpRiskRecentStatsRequest) => Promise<SignUpRiskRecentStats>,
};

export type SignUpRiskEngine = {
  calculateRiskAssessment: (
    context: SignUpRiskScoreContext,
    dependencies: SignUpRiskEngineDependencies,
  ) => Promise<SignUpRiskAssessment>,
};


// -- DB queries --------------------------------------------------------------

async function loadRecentSignUpStats(
  tenancy: Tenancy,
  request: SignUpRiskRecentStatsRequest,
): Promise<SignUpRiskRecentStats> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const windowStart = new Date(request.signedUpAt.getTime() - request.recentWindowHours * 60 * 60 * 1000);

  const [sameIpRows, sameEmailRows, similarEmailRows] = await Promise.all([
    request.signUpIp == null || request.sameIpLimit === 0
      ? []
      : prisma.$replica().$queryRaw<{ matched: number }[]>`
          SELECT 1 AS "matched"
          FROM ${sqlQuoteIdent(schema)}."ProjectUser"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "isAnonymous" = false
            AND "signedUpAt" >= ${windowStart}
            AND "signUpIp" = ${request.signUpIp}
          LIMIT ${request.sameIpLimit}
        `,

    request.signUpEmailNormalized == null || request.sameEmailLimit === 0
      ? []
      : prisma.$replica().$queryRaw<{ matched: number }[]>`
          SELECT 1 AS "matched"
          FROM ${sqlQuoteIdent(schema)}."ProjectUser"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "isAnonymous" = false
            AND "signedUpAt" >= ${windowStart}
            AND "signUpEmailNormalized" = ${request.signUpEmailNormalized}
          LIMIT ${request.sameEmailLimit}
        `,

    request.signUpEmailBase == null || request.similarEmailLimit === 0
      ? []
      : prisma.$replica().$queryRaw<{ matched: number }[]>`
          SELECT 1 AS "matched"
          FROM ${sqlQuoteIdent(schema)}."ProjectUser"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "isAnonymous" = false
            AND "signedUpAt" >= ${windowStart}
            AND "signUpEmailBase" = ${request.signUpEmailBase}
          LIMIT ${request.similarEmailLimit}
        `,
  ]);

  return {
    sameIpCount: sameIpRows.length,
    sameEmailCount: sameEmailRows.length,
    similarEmailCount: similarEmailRows.length,
  };
}

function createDependencies(tenancy: Tenancy) {
  return {
    checkPrimaryEmailRisk: async (email: string) => ({
      emailableScore: (await checkEmailWithEmailable(email)).emailableScore,
    }),
    loadRecentSignUpStats: (request: SignUpRiskRecentStatsRequest) => loadRecentSignUpStats(tenancy, request),
  };
}


// -- Public API --------------------------------------------------------------

export async function calculateSignUpRiskAssessment(
  tenancy: Tenancy,
  context: SignUpRiskScoreContext,
): Promise<SignUpRiskAssessment> {
  return await signUpRiskEngine.calculateRiskAssessment(context, createDependencies(tenancy));
}

export async function calculateSignUpRiskScores(
  tenancy: Tenancy,
  context: SignUpRiskScoreContext,
): Promise<SignUpRiskScores> {
  return (await calculateSignUpRiskAssessment(tenancy, context)).scores;
}

// -- Tests -------------------------------------------------------------------

import.meta.vitest?.test("private sign-up risk engine resolves at module init", ({ expect }) => {
  expect(typeof signUpRiskEngine.calculateRiskAssessment).toBe("function");
});

import.meta.vitest?.test("loaded private sign-up risk engine can calculate scores", async ({ expect }) => {
  const { vi } = import.meta.vitest!;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-20T00:00:00.000Z"));

  try {
    const assessment = await signUpRiskEngine.calculateRiskAssessment({
      primaryEmail: null,
      primaryEmailVerified: false,
      authMethod: "password",
      oauthProvider: null,
      ipAddress: null,
      ipTrusted: null,
      countryCode: null,
      oauthAccountCreatedAtMillis: null,
      turnstileAssessment: { status: "ok" },
    }, {
      checkPrimaryEmailRisk: async () => ({ emailableScore: null }),
      loadRecentSignUpStats: async () => ({ sameIpCount: 0, sameEmailCount: 0, similarEmailCount: 0 }),
    });

    expect({
      scores: assessment.scores,
      heuristicFacts: assessment.heuristicFacts,
    }).toMatchInlineSnapshot(`
      {
        "heuristicFacts": {
          "emailBase": null,
          "emailNormalized": null,
          "signUpEmailBase": null,
          "signUpEmailNormalized": null,
          "signUpIp": null,
          "signUpIpTrusted": null,
          "signedUpAt": 2026-03-20T00:00:00.000Z,
        },
        "scores": {
          "bot": 0,
          "free_trial_abuse": 0,
        },
      }
    `);
    expect(Array.isArray(assessment.breakdown)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
