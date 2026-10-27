import { VerificationCodeType } from "@/generated/prisma/client";
import { serializeStoredSignUpRequestContext } from "@/lib/sign-up-context";
import { createRateLimitedSmsCode, isSmsProviderConfigured, sendSms } from "@/lib/sms";
import { botChallengeFlowRequestSchemaFields, getRequestContextAndBotChallengeAssessment } from "@/lib/turnstile";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, phoneNumberSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { KnownErrors } from "@hexclave/shared";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { assertSmsSignInEnabled, ensureUserForPhoneNumberAllowsSmsOtp, smsSignInVerificationCodeHandler } from "../sign-in/verification-code-handler";

// SMS codes are short-lived, unlike email OTPs (which double as magic links that may be opened much later)
const SMS_CODE_EXPIRY_MS = 1000 * 60 * 10;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Send SMS sign-in code",
    description: "Send a one-time sign-in code to a phone number via SMS. The phone number must be in E.164 format.",
    tags: ["SMS"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
    }).defined(),
    body: yupObject({
      phone_number: phoneNumberSchema.defined().meta({ openapiField: { description: 'The phone number to send the sign-in code to, in E.164 format', exampleValue: '+15555550100' } }),
      ...botChallengeFlowRequestSchemaFields,
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      nonce: yupString().defined().meta({ openapiField: { description: "A token that must be stored temporarily and provided when verifying the 6-character code", exampleValue: "u3h6gn4w24pqc8ya679inrhjwh1rybth6a7thurqhnpf2" } }),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, body: { phone_number: phoneNumber, ...botChallenge } }) {
    assertSmsSignInEnabled(tenancy);
    if (!isSmsProviderConfigured(tenancy)) {
      throw new StatusError(StatusError.BadRequest, "SMS sign-in is enabled, but no SMS provider is configured for this project.");
    }

    await ensureUserForPhoneNumberAllowsSmsOtp(tenancy, phoneNumber);

    const { requestContext, turnstileAssessment } = await getRequestContextAndBotChallengeAssessment(botChallenge, "send_sms_sign_in_code", tenancy);
    // Other bot-challenge-protected routes only record a failed assessment and let the sign-up risk scoring deal with
    // it later. That doesn't work here: the SMS is billed to the project as soon as we send it, so a caller that skips
    // the challenge (no phase, or `bot_challenge_unavailable`) could otherwise pump SMS to numbers they own. We
    // therefore require that either the invisible or the visible challenge passed before creating and sending a code.
    if (turnstileAssessment.status !== "ok" && turnstileAssessment.visibleChallengeResult !== "ok") {
      throw new KnownErrors.BotChallengeFailed("A passed bot challenge is required to send an SMS sign-in code.");
    }

    const codeObj = await createRateLimitedSmsCode(tenancy, VerificationCodeType.SMS_ONE_TIME_PASSWORD, phoneNumber, async (transaction) => await smsSignInVerificationCodeHandler.createCode({
      transaction,
      tenancy,
      method: { phone_number: phoneNumber },
      expiresInMs: SMS_CODE_EXPIRY_MS,
      callbackUrl: undefined,
      data: {
        phone_number: phoneNumber,
        turnstile_result: turnstileAssessment.status,
        turnstile_visible_challenge_result: turnstileAssessment.visibleChallengeResult,
        ...serializeStoredSignUpRequestContext(requestContext),
      },
    }));

    await sendSms(tenancy, {
      to: phoneNumber,
      body: `${codeObj.code.slice(0, 6).toUpperCase()} is your ${tenancy.project.display_name} sign-in code.`,
      purpose: "sign_in_code",
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { nonce: codeObj.code.slice(6) },
    };
  },
});
