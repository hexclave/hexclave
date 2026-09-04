import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { isValidCountryCode, normalizeCountryCode } from "@hexclave/shared/dist/schema-fields";
import { SignUpAuthMethod } from "@hexclave/shared/dist/utils/auth-methods";
import { getEnvBoolean, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { KeyIntersect } from "@hexclave/shared/dist/utils/types";
import { createSignUpRuleContext } from "./cel-evaluator";
import { BestEffortEndUserRequestContext, getBestEffortEndUserRequestContext } from "./end-users";
import { calculateSignUpRiskAssessment } from "./risk-scores";
import { evaluateSignUpRules } from "./sign-up-rules";
import { Tenancy } from "./tenancies";
import { SignUpTurnstileAssessment } from "./turnstile";

/**
 * Options for sign-up rule evaluation context.
 */
export type SignUpRuleOptions = {
  authMethod: SignUpAuthMethod,
  oauthProvider: string | null,
  ipAddress: string | null,
  ipTrusted: boolean | null,
  countryCode: string | null,
  oauthAccountCreatedAtMillis: number | null,
  requestContext?: BestEffortEndUserRequestContext | null,
  turnstileAssessment: SignUpTurnstileAssessment,
};

function shouldAllowSignUpAfterVisibleBotChallengeFailure(): boolean {
  return getEnvBoolean("STACK_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE");
}

function isVisibleBotChallengeFailure(assessment: SignUpTurnstileAssessment): boolean {
  return assessment.visibleChallengeResult != null && assessment.visibleChallengeResult !== "ok";
}

function assertVisibleBotChallengePassedForSignUp(assessment: SignUpTurnstileAssessment) {
  if (isVisibleBotChallengeFailure(assessment) && !shouldAllowSignUpAfterVisibleBotChallengeFailure()) {
    throw new KnownErrors.BotChallengeFailed("Visible bot challenge could not be completed");
  }
}

async function persistSignUpHeuristicFacts(params: {
  tenancy: Tenancy,
  userId: string,
  signedUpAt: Date,
  signUpIp: string | null,
  signUpIpTrusted: boolean | null,
  signUpEmailNormalized: string | null,
  signUpEmailBase: string | null,
}) {
  const prisma = await getPrismaClientForTenancy(params.tenancy);
  const schema = await getPrismaSchemaForTenancy(params.tenancy);
  await prisma.$executeRaw`
    UPDATE ${sqlQuoteIdent(schema)}."ProjectUser"
    SET
      "signedUpAt" = ${params.signedUpAt},
      "signUpIp" = ${params.signUpIp},
      "signUpIpTrusted" = ${params.signUpIpTrusted},
      "signUpEmailNormalized" = ${params.signUpEmailNormalized},
      "signUpEmailBase" = ${params.signUpEmailBase},
      "shouldUpdateSequenceId" = true
    WHERE "tenancyId" = ${params.tenancy.id}::UUID
      AND "projectUserId" = ${params.userId}::UUID
  `;
}

export function getDerivedSignUpCountryCode(requestCountryCode: string | null, email: string | null): string | null {
  // In testing/development, allow deriving country code from email tags
  // e.g. "user+CA@example.com" → "CA". Only works for @example.com addresses.
  // Guarded to non-production environments to prevent user-controlled country code spoofing.
  if (email != null && ["development", "test"].includes(getNodeEnvironment())) {
    const match = email.match(/^[^+]+\+([^@]+)@example\.com$/i);
    if (match) {
      const tag = match[1];
      const normalized = normalizeCountryCode(tag);
      if (isValidCountryCode(normalized)) {
        return normalized;
      }
    }
  }

  if (requestCountryCode !== null) {
    const normalized = normalizeCountryCode(requestCountryCode);
    if (isValidCountryCode(normalized)) {
      return normalized;
    }
  }
  return null;
}

import.meta.vitest?.test("getDerivedSignUpCountryCode", ({ expect }) => {
  expect(getDerivedSignUpCountryCode(" us ", null)).toBe("US");
  expect(getDerivedSignUpCountryCode("de", null)).toBe("DE");
  expect(getDerivedSignUpCountryCode("US", null)).toBe("US");
  expect(getDerivedSignUpCountryCode("usa", null)).toBeNull();
  expect(getDerivedSignUpCountryCode("1", null)).toBeNull();
  expect(getDerivedSignUpCountryCode(null, null)).toBeNull();

  // email tag derivation in dev/test environments
  expect(getDerivedSignUpCountryCode(null, "test+us@example.com")).toBe("US");
  expect(getDerivedSignUpCountryCode(null, "test+de@example.com")).toBe("DE");
  expect(getDerivedSignUpCountryCode(null, "test+US@example.com")).toBe("US");
  expect(getDerivedSignUpCountryCode(null, "test+invalid@example.com")).toBeNull();
  expect(getDerivedSignUpCountryCode(null, "test+us@other.com")).toBeNull();
  expect(getDerivedSignUpCountryCode(null, "test@example.com")).toBeNull();
  expect(getDerivedSignUpCountryCode(null, "noplustag@example.com")).toBeNull();

  // email tag takes precedence over requestCountryCode
  expect(getDerivedSignUpCountryCode("de", "test+us@example.com")).toBe("US");
  expect(getDerivedSignUpCountryCode("de", "test@example.com")).toBe("DE");
});

import.meta.vitest?.describe("visible bot challenge sign-up policy", () => {
  const { expect, test, beforeEach, afterEach } = import.meta.vitest!;
  const processEnv = process["env"];
  const originalFlag = processEnv["HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE"];

  beforeEach(() => {
    Reflect.deleteProperty(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE");
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      Reflect.deleteProperty(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE");
    } else {
      Reflect.set(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE", originalFlag);
    }
  });

  test("blocks sign-up by default after a visible challenge failure", () => {
    expect(() => assertVisibleBotChallengePassedForSignUp({
      status: "error",
      visibleChallengeResult: "error",
    })).toThrowError("Visible bot challenge could not be completed");
  });

  test("allows sign-up when visible challenge failure override is enabled", () => {
    Reflect.set(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE", "true");

    expect(() => assertVisibleBotChallengePassedForSignUp({
      status: "error",
      visibleChallengeResult: "error",
    })).not.toThrow();
  });

  test("treats invalid visible challenges as bypassable failures when the override is enabled", () => {
    Reflect.set(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE", "true");

    expect(() => assertVisibleBotChallengePassedForSignUp({
      status: "invalid",
      visibleChallengeResult: "invalid",
    })).not.toThrow();
  });
});

/**
 * Creates or upgrades an anonymous user with sign-up rule evaluation.
 *
 * This function evaluates sign-up rules before creating/upgrading the user.
 * Use this for all signup paths:
 * - Password signup
 * - OTP signup
 * - OAuth signup
 * - Passkey signup
 * - Anonymous user conversion
 *
 * Do NOT use this for creating anonymous users (use createOrUpgradeAnonymousUserWithoutRules directly).
 *
 * @param tenancy - The tenancy context
 * @param currentUser - Current user (if any, for anonymous upgrade)
 * @param createOrUpdate - User creation/update data
 * @param allowedErrorTypes - Error types to allow
 * @param signUpRuleOptions - Options for sign-up rule evaluation
 * @returns Created or updated user
 * @throws KnownErrors.SignUpRejected if a sign-up rule rejects the signup
 */
export async function createOrUpgradeAnonymousUserWithRules(
  tenancy: Tenancy,
  currentUser: UsersCrud["Admin"]["Read"] | null,
  createOrUpdate: KeyIntersect<UsersCrud["Admin"]["Create"], UsersCrud["Admin"]["Update"]>,
  allowedErrorTypes: (new (...args: any) => any)[],
  signUpRuleOptions: SignUpRuleOptions,
): Promise<UsersCrud["Admin"]["Read"]> {
  assertVisibleBotChallengePassedForSignUp(signUpRuleOptions.turnstileAssessment);

  const email = createOrUpdate.primary_email ?? currentUser?.primary_email ?? null;
  const primaryEmailVerified = createOrUpdate.primary_email_verified ?? currentUser?.primary_email_verified ?? false;
  const endUserRequestContext = signUpRuleOptions.requestContext !== undefined
    ? signUpRuleOptions.requestContext
    : signUpRuleOptions.ipAddress !== null && signUpRuleOptions.ipTrusted !== null
      ? null
      : await getBestEffortEndUserRequestContext();
  const requestIpAddress = signUpRuleOptions.ipAddress ?? endUserRequestContext?.ipAddress ?? null;
  const requestIpTrusted = signUpRuleOptions.ipTrusted ?? endUserRequestContext?.ipTrusted ?? null;
  // EndUserLocation.countryCode is string | undefined; coerce to string | null for downstream consumers
  const requestCountryCode = signUpRuleOptions.countryCode ?? endUserRequestContext?.location?.countryCode ?? null;
  const countryCode = getDerivedSignUpCountryCode(requestCountryCode, email);
  const countryCodeToPersist = currentUser?.is_anonymous && currentUser.country_code != null
    ? currentUser.country_code
    : countryCode;

  const riskAssessment = await calculateSignUpRiskAssessment(tenancy, {
    primaryEmail: email ?? null,
    primaryEmailVerified,
    authMethod: signUpRuleOptions.authMethod,
    oauthProvider: signUpRuleOptions.oauthProvider,
    ipAddress: requestIpAddress,
    ipTrusted: requestIpTrusted,
    countryCode: countryCodeToPersist,
    oauthAccountCreatedAtMillis: signUpRuleOptions.oauthAccountCreatedAtMillis,
    turnstileAssessment: signUpRuleOptions.turnstileAssessment,
  });
  const riskScores = riskAssessment.scores;

  const ruleResult = await evaluateSignUpRules(tenancy, createSignUpRuleContext({
    email,
    countryCode,
    authMethod: signUpRuleOptions.authMethod,
    oauthProvider: signUpRuleOptions.oauthProvider,
    riskScores,
  }));

  if (!ruleResult.shouldAllow) {
    throw new KnownErrors.SignUpRejected();
  }

  const existingRestrictionPrivateDetails = createOrUpdate.restricted_by_admin_private_details ?? currentUser?.restricted_by_admin_private_details;
  const restrictionRuleId = ruleResult.restrictedBecauseOfSignUpRuleId;
  const restrictionRuleDisplayName = restrictionRuleId
    ? (tenancy.config.auth.signUpRules[restrictionRuleId].displayName ?? "")
    : "";
  const restrictionPrivateDetails = restrictionRuleId
    ? `Restricted by sign-up rule: ${restrictionRuleId}${restrictionRuleDisplayName ? ` (${restrictionRuleDisplayName})` : ""}`
    : null;

  const enrichedCreateOrUpdate = {
    ...createOrUpdate,
    ...(ruleResult.restrictedBecauseOfSignUpRuleId != null ? {
      restricted_by_admin: true,
      restricted_by_admin_private_details: existingRestrictionPrivateDetails != null ? `${existingRestrictionPrivateDetails}\n\n${restrictionPrivateDetails}` : restrictionPrivateDetails,
    } : {}),
    ...(countryCodeToPersist !== null ? { country_code: countryCodeToPersist } : {}),
    risk_scores: {
      sign_up: {
        bot: riskScores.bot,
        free_trial_abuse: riskScores.free_trial_abuse,
      },
    },
  };

  const signUpHeuristicFactsToPersist = {
    tenancy,
    signedUpAt: riskAssessment.heuristicFacts.signedUpAt,
    signUpIp: riskAssessment.heuristicFacts.signUpIp,
    signUpIpTrusted: riskAssessment.heuristicFacts.signUpIpTrusted,
    signUpEmailNormalized: riskAssessment.heuristicFacts.signUpEmailNormalized,
    signUpEmailBase: riskAssessment.heuristicFacts.signUpEmailBase,
  } as const;

  const user = await createOrUpgradeAnonymousUserWithoutRules(
    tenancy,
    currentUser,
    enrichedCreateOrUpdate as KeyIntersect<UsersCrud["Admin"]["Create"], UsersCrud["Admin"]["Update"]>,
    allowedErrorTypes,
  );

  try {
    await persistSignUpHeuristicFacts({
      ...signUpHeuristicFactsToPersist,
      userId: user.id,
    });
  } catch (error) {
    captureError("persist-sign-up-heuristic-facts", error);
  }

  return user;
}

/**
 * Creates or upgrades an anonymous user WITHOUT sign-up rule evaluation.
 *
 * Use this only for:
 * - Creating anonymous users (no rules apply)
 * - Internal operations where rules should be bypassed
 *
 * For all signup paths, use createOrUpgradeAnonymousUserWithRules instead.
 */
export async function createOrUpgradeAnonymousUserWithoutRules(
  tenancy: Tenancy,
  currentUser: UsersCrud["Admin"]["Read"] | null,
  createOrUpdate: KeyIntersect<UsersCrud["Admin"]["Create"], UsersCrud["Admin"]["Update"]>,
  allowedErrorTypes: (new (...args: any) => any)[],
): Promise<UsersCrud["Admin"]["Read"]> {
  if (currentUser?.is_anonymous) {
    // Upgrade anonymous user
    return await usersCrudHandlers.adminUpdate({
      tenancy,
      user_id: currentUser.id,
      data: {
        ...createOrUpdate,
        is_anonymous: false,
      },
      allowedErrorTypes,
    });
  } else {
    // Create new user (normal flow)
    // Cast needed: createOrUpdate may contain create-only fields (like risk scores) that
    // KeyIntersect<Create, Update> strips from the type since they're absent on Update
    return await usersCrudHandlers.adminCreate({
      tenancy,
      data: createOrUpdate as UsersCrud["Admin"]["Create"],
      allowedErrorTypes,
    });
  }
}
