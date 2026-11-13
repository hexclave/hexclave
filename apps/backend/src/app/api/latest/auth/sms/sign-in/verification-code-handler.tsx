import { VerificationCodeType } from "@/generated/prisma/client";
import { logSignInAttemptInBackground } from "@/lib/compliance-events";
import { getAuthContactChannel } from "@/lib/contact-channel";
import { buildSignUpRuleOptions, deserializeStoredSignUpRequestContext, deserializeStoredTurnstileAssessment, storedSignUpRequestContextSchemaFields } from "@/lib/sign-up-context";
import { Tenancy } from "@/lib/tenancies";
import { createAuthTokens } from "@/lib/tokens";
import { createOrUpgradeAnonymousUserWithRules } from "@/lib/users";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { KnownErrors } from "@hexclave/shared";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { phoneNumberSchema, signInResponseSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { turnstileResultValues } from "@hexclave/shared/dist/utils/turnstile";
import { createMfaRequiredError } from "../../mfa/sign-in/verification-code-handler";
import { ensureUserForAuthContactChannelAllowsOtp } from "../../otp/sign-in/verification-code-handler";

export async function ensureUserForPhoneNumberAllowsSmsOtp(tenancy: Tenancy, phoneNumber: string): Promise<UsersCrud["Admin"]["Read"] | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const contactChannel = await getAuthContactChannel(prisma, {
    tenancyId: tenancy.id,
    type: "PHONE",
    value: phoneNumber,
  });
  return await ensureUserForAuthContactChannelAllowsOtp(
    tenancy,
    contactChannel,
    (value) => new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse("phone", value, true),
  );
}

export function assertSmsSignInEnabled(tenancy: Tenancy) {
  if (!tenancy.config.auth.sms.allowSignIn) {
    throw new StatusError(StatusError.Forbidden, "SMS sign-in is not enabled for this project");
  }
}

/**
 * Sign-in with a one-time code sent via SMS. This is the SMS counterpart of the email OTP flow in `auth/otp`; it uses
 * the same code format (the 6 characters the user enters, concatenated with the nonce returned when sending the code),
 * but a separate verification code type, so that a code sent by email can never be redeemed as an SMS code and vice
 * versa.
 *
 * Unlike the email flow there is no magic link, as links in SMS are commonly flagged as phishing by carriers.
 */
export const smsSignInVerificationCodeHandler = createVerificationCodeHandler({
  metadata: {
    post: {
      summary: "Sign in with an SMS code",
      description: "Signs in (or signs up) a user with the code that was sent to their phone number via SMS",
      tags: ["SMS"],
    },
    check: {
      summary: "Check SMS sign in code",
      description: "Check if an SMS sign in code is valid without using it",
      tags: ["SMS"],
    },
    codeDescription: `A 45-character verification code, formed by concatenating the 6-character code sent via SMS with the nonce received when the code was sent`,
  },
  type: VerificationCodeType.SMS_ONE_TIME_PASSWORD,
  data: yupObject({
    // Duplicated from the method, as `data` has a GIN index that we use for rate-limiting, see `send-sign-in-code`
    phone_number: phoneNumberSchema.defined(),
    turnstile_result: yupString().oneOf(turnstileResultValues).optional(),
    turnstile_visible_challenge_result: yupString().oneOf(turnstileResultValues).optional(),
    ...storedSignUpRequestContextSchemaFields,
  }),
  method: yupObject({
    phone_number: phoneNumberSchema.defined(),
  }),
  complianceSignInAttempt: true,
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: signInResponseSchema.defined(),
  }),
  async handler(tenancy, { phone_number: phoneNumber }, data, requestBody, currentUser, apiUrl) {
    // The project may have disabled SMS sign-in after the code was sent
    assertSmsSignInEnabled(tenancy);

    let user = await ensureUserForPhoneNumberAllowsSmsOtp(tenancy, phoneNumber);
    let isNewUser = false;

    if (!user) {
      user = await createOrUpgradeAnonymousUserWithRules(
        tenancy,
        currentUser ?? null,
        {
          primary_phone_number: phoneNumber,
          primary_phone_number_verified: true,
          primary_phone_number_auth_enabled: true,
          otp_auth_enabled: true,
        },
        [],
        buildSignUpRuleOptions({
          // Sign-up rules and risk scoring currently don't distinguish between email and SMS one-time codes
          authMethod: 'otp',
          oauthProvider: null,
          oauthAccountCreatedAtMillis: null,
          requestContext: deserializeStoredSignUpRequestContext(data),
          turnstileAssessment: deserializeStoredTurnstileAssessment(
            data.turnstile_result,
            data.turnstile_visible_challenge_result,
          ),
        })
      );
      isNewUser = true;
    }

    if (user.requires_totp_mfa) {
      throw await createMfaRequiredError({
        project: tenancy.project,
        branchId: tenancy.branchId,
        userId: user.id,
        isNewUser,
        method: "otp",
      });
    }

    const { refreshToken, accessToken } = await createAuthTokens({
      tenancy,
      projectUserId: user.id,
      apiUrl,
    });
    logSignInAttemptInBackground(tenancy, {
      outcome: "success",
      method: "otp",
      userId: user.id,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        refresh_token: refreshToken,
        access_token: accessToken,
        is_new_user: isNewUser,
        user_id: user.id,
      },
    };
  },
});
