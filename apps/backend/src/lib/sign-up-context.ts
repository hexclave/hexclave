import { yupBoolean, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { SignUpAuthMethod } from "@hexclave/shared/dist/utils/auth-methods";
import { BestEffortEndUserRequestContext } from "./end-users";
import { SignUpTurnstileAssessment } from "./turnstile";
import { SignUpRuleOptions } from "./users";

export const storedSignUpRequestContextSchemaFields = {
  sign_up_ip_address: yupString().nullable().optional(),
  sign_up_ip_trusted: yupBoolean().nullable().optional(),
  sign_up_country_code: yupString().nullable().optional(),
} as const;

export type StoredSignUpRequestContext = {
  sign_up_ip_address: string | null,
  sign_up_ip_trusted: boolean | null,
  sign_up_country_code: string | null,
};

export function serializeStoredSignUpRequestContext(requestContext: BestEffortEndUserRequestContext): StoredSignUpRequestContext {
  return {
    sign_up_ip_address: requestContext.ipAddress,
    sign_up_ip_trusted: requestContext.ipTrusted,
    sign_up_country_code: requestContext.location?.countryCode ?? null,
  };
}

export function deserializeStoredSignUpRequestContext(data: Partial<StoredSignUpRequestContext>): BestEffortEndUserRequestContext | null {
  const signUpIpAddress = data.sign_up_ip_address ?? null;
  const signUpIpTrusted = data.sign_up_ip_trusted ?? null;
  const signUpCountryCode = data.sign_up_country_code ?? null;

  if (signUpIpAddress == null && signUpIpTrusted == null && signUpCountryCode == null) {
    return null;
  }

  return {
    ipAddress: signUpIpAddress,
    ipTrusted: signUpIpTrusted,
    location: signUpCountryCode == null ? null : {
      countryCode: signUpCountryCode,
    },
  };
}

/**
 * Builds a `SignUpRuleOptions` from a request context and auth details.
 * Centralises the boilerplate that every auth route previously duplicated.
 */
export function buildSignUpRuleOptions(params: {
  authMethod: SignUpAuthMethod,
  oauthProvider: string | null,
  oauthAccountCreatedAtMillis: number | null,
  requestContext: BestEffortEndUserRequestContext | null,
  turnstileAssessment: SignUpTurnstileAssessment,
}): SignUpRuleOptions {
  return {
    authMethod: params.authMethod,
    oauthProvider: params.oauthProvider,
    ipAddress: params.requestContext?.ipAddress ?? null,
    ipTrusted: params.requestContext?.ipTrusted ?? null,
    countryCode: params.requestContext?.location?.countryCode ?? null,
    oauthAccountCreatedAtMillis: params.oauthAccountCreatedAtMillis,
    requestContext: params.requestContext,
    turnstileAssessment: params.turnstileAssessment,
  };
}

/**
 * Reconstructs a `SignUpTurnstileAssessment` from stored status/result values.
 * Used in OAuth callbacks and OTP verification where the assessment was serialized.
 */
export function reconstructTurnstileAssessment(
  status: SignUpTurnstileAssessment["status"],
  visibleChallengeResult?: SignUpTurnstileAssessment["visibleChallengeResult"],
): SignUpTurnstileAssessment {
  if (visibleChallengeResult != null) {
    return { status, visibleChallengeResult };
  }
  return { status };
}

export function deserializeStoredTurnstileAssessment(
  status: SignUpTurnstileAssessment["status"] | undefined,
  visibleChallengeResult?: SignUpTurnstileAssessment["visibleChallengeResult"],
): SignUpTurnstileAssessment {
  if (status == null) {
    return { status: "error" };
  }
  return reconstructTurnstileAssessment(status, visibleChallengeResult);
}


// ── Tests ──────────────────────────────────────────────────────────────

import.meta.vitest?.describe("stored sign-up context helpers", () => {
  const { expect, test } = import.meta.vitest!;

  test("backward-compatible schema accepts missing stored request context fields", async () => {
    await expect(yupObject(storedSignUpRequestContextSchemaFields).defined().validate({})).resolves.toEqual({});
  });

  test("missing stored request context deserializes to null", () => {
    expect(deserializeStoredSignUpRequestContext({})).toBeNull();
  });

  test("missing stored turnstile result falls back to a neutral assessment", () => {
    expect(deserializeStoredTurnstileAssessment(undefined)).toEqual({ status: "error" });
  });
});
