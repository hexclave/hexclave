import { validateRedirectUrl } from "@/lib/redirect-urls";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { buildSignUpRuleOptions } from "@/lib/sign-up-context";
import { createAuthTokens } from "@/lib/tokens";
import { getRequestContextAndBotChallengeAssessment, botChallengeFlowRequestSchemaFields } from "@/lib/turnstile";
import { createOrUpgradeAnonymousUserWithRules } from "@/lib/users";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { getPasswordError } from "@hexclave/shared/dist/helpers/password";
import { adaptSchema, clientOrHigherAuthTypeSchema, emailVerificationCallbackUrlSchema, passwordSchema, signInEmailSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { contactChannelVerificationCodeHandler } from "../../../contact-channels/verify/verification-code-handler";
import { createMfaRequiredError } from "../../mfa/sign-in/verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Sign up with email and password",
    description: "Create a new account with email and password",
    tags: ["Password"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema.optional()
    }).defined(),
    body: yupObject({
      email: signInEmailSchema.defined(),
      password: passwordSchema.defined(),
      verification_callback_url: emailVerificationCallbackUrlSchema.optional(),
      ...botChallengeFlowRequestSchemaFields,
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      access_token: yupString().defined(),
      refresh_token: yupString().defined(),
      user_id: yupString().defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy, user: currentUser }, body: { email, password, verification_callback_url: verificationCallbackUrl, ...botChallenge } }, fullReq) {
    if (!tenancy.config.auth.password.allowSignIn) {
      throw new KnownErrors.PasswordAuthenticationNotEnabled();
    }

    if (verificationCallbackUrl && !validateRedirectUrl(verificationCallbackUrl, tenancy)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(verificationCallbackUrl);
    }

    if (!tenancy.config.auth.allowSignUp) {
      throw new KnownErrors.SignUpNotEnabled();
    }

    const passwordError = getPasswordError(password);
    if (passwordError) {
      throw passwordError;
    }

    const { requestContext, turnstileAssessment } = await getRequestContextAndBotChallengeAssessment(botChallenge, "sign_up_with_credential", tenancy);

    const createdUser = await createOrUpgradeAnonymousUserWithRules(
      tenancy,
      currentUser ?? null,
      {
        primary_email: email,
        primary_email_verified: false,
        primary_email_auth_enabled: true,
        password,
      },
      [KnownErrors.UserWithEmailAlreadyExists, KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse],
      buildSignUpRuleOptions({
        authMethod: 'password',
        oauthProvider: null,
        oauthAccountCreatedAtMillis: null,
        requestContext,
        turnstileAssessment,
      })
    );

    if (verificationCallbackUrl) {
      runAsynchronouslyAndWaitUntil((async () => {
        await contactChannelVerificationCodeHandler.sendCode({
          tenancy,
          data: {
            user_id: createdUser.id,
          },
          method: {
            email,
          },
          callbackUrl: verificationCallbackUrl,
        }, {
          user: createdUser,
          shouldSkipDeliverabilityCheck: false,
        });
      })());
    }

    if (createdUser.requires_totp_mfa) {
      throw await createMfaRequiredError({
        project: tenancy.project,
        branchId: tenancy.branchId,
        isNewUser: true,
        userId: createdUser.id,
      });
    }

    const { refreshToken, accessToken } = await createAuthTokens({
      tenancy,
      projectUserId: createdUser.id,
      apiUrl: getApiUrlForRequest(fullReq),
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user_id: createdUser.id,
      },
    };
  },
});
