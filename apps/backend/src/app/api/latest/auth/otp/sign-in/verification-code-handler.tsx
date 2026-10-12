import { VerificationCodeType } from "@/generated/prisma/client";
import { logSignInAttemptInBackground } from "@/lib/compliance-events";
import { getAuthContactChannelWithEmailNormalization } from "@/lib/contact-channel";
import { sendEmailFromDefaultTemplate } from "@/lib/emails";
import { getSoleTenancyFromProjectBranch, Tenancy } from "@/lib/tenancies";
import { createAuthTokens } from "@/lib/tokens";
import { buildSignUpRuleOptions, deserializeStoredSignUpRequestContext, deserializeStoredTurnstileAssessment, storedSignUpRequestContextSchemaFields } from "@/lib/sign-up-context";
import { createOrUpgradeAnonymousUserWithRules } from "@/lib/users";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { KnownErrors } from "@hexclave/shared";
import { turnstileResultValues } from "@hexclave/shared/dist/utils/turnstile";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { emailSchema, signInResponseSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { usersCrudHandlers } from "../../../users/crud";
import { createMfaRequiredError } from "../../mfa/sign-in/verification-code-handler";

export async function ensureUserForEmailAllowsOtp(tenancy: Tenancy, email: string): Promise<UsersCrud["Admin"]["Read"] | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const contactChannel = await getAuthContactChannelWithEmailNormalization(
    prisma,
    {
      tenancyId: tenancy.id,
      type: "EMAIL",
      value: email,
    }
  );

  if (contactChannel) {
    const otpAuthMethod = contactChannel.projectUser.authMethods.find((m) => m.otpAuthMethod)?.otpAuthMethod;

    if (contactChannel.isVerified) {
      if (!otpAuthMethod) {
        // automatically merge the otp auth method with the existing account

        await prisma.authMethod.create({
          data: {
            projectUserId: contactChannel.projectUser.projectUserId,
            tenancyId: tenancy.id,
            otpAuthMethod: {
              create: {
                projectUserId: contactChannel.projectUser.projectUserId,
              }
            }
          },
        });
      }

      return await usersCrudHandlers.adminRead({
        tenancy,
        user_id: contactChannel.projectUser.projectUserId,
      });
    } else {
      throw new KnownErrors.UserWithEmailAlreadyExists(contactChannel.value, true);
    }
  } else {
    if (!tenancy.config.auth.allowSignUp) {
      throw new KnownErrors.SignUpNotEnabled();
    }
    return null;
  }
}

export const signInVerificationCodeHandler = createVerificationCodeHandler({
  metadata: {
    post: {
      summary: "Sign in with a code",
      description: "",
      tags: ["OTP"],
    },
    check: {
      summary: "Check sign in code",
      description: "Check if a sign in code is valid without using it",
      tags: ["OTP"],
    },
    codeDescription: `A 45-character verification code. For magic links, this is the code found in the "code" URL query parameter. For OTP, this is formed by concatenating the 6-digit code entered by the user with the nonce (received during code creation)`,
  },
  type: VerificationCodeType.ONE_TIME_PASSWORD,
  data: yupObject({
    turnstile_result: yupString().oneOf(turnstileResultValues).optional(),
    turnstile_visible_challenge_result: yupString().oneOf(turnstileResultValues).optional(),
    ...storedSignUpRequestContextSchemaFields,
  }),
  method: yupObject({
    email: emailSchema.defined(),
  }),
  complianceSignInAttempt: true,
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: signInResponseSchema.defined(),
  }),
  async send(codeObj, createOptions, sendOptions: { email: string }) {
    const tenancy = await getSoleTenancyFromProjectBranch(createOptions.project.id, createOptions.branchId);
    await sendEmailFromDefaultTemplate({
      tenancy,
      email: createOptions.method.email,
      user: null,
      templateType: "magic_link",
      extraVariables: {
        magicLink: codeObj.link.toString(),
        otp: codeObj.code.slice(0, 6).toUpperCase(),
      },
      shouldSkipDeliverabilityCheck: true,
    });

    return {
      nonce: codeObj.code.slice(6),
    };
  },
  async handler(tenancy, { email }, data, requestBody, currentUser, apiUrl) {
    let user = await ensureUserForEmailAllowsOtp(tenancy, email);
    let isNewUser = false;

    if (!user) {
      // Note: Request context (IP, user agent) is not available in verification code handler
      // The rule evaluation will proceed with limited context
      user = await createOrUpgradeAnonymousUserWithRules(
        tenancy,
        currentUser ?? null,
        {
          primary_email: email,
          primary_email_verified: true,
          primary_email_auth_enabled: true,
          otp_auth_enabled: true,
        },
        [],
        buildSignUpRuleOptions({
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
        email,
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
      email,
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
