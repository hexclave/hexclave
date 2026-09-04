import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  generateRegistrationOptions,
  GenerateRegistrationOptionsOpts,
} from '@simplewebauthn/server';
import { isoUint8Array } from '@simplewebauthn/server/helpers';
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { registerVerificationCodeHandler } from "../register/verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Initialize registration of new passkey",
    description: "Create a challenge for passkey registration",
    tags: ["Passkey"],
    hidden: true,

  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema.defined(),
    }).defined()
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      options_json: yupMixed().defined(),
      code: yupString().defined(),
    }),
  }),
  async handler({ auth: { tenancy, user } }) {
    if (!tenancy.config.auth.passkey.allowSignIn) {
      throw new KnownErrors.PasskeyAuthenticationNotEnabled();
    }

    const REGISTRATION_TIMEOUT_MS = 60000;

    const opts: GenerateRegistrationOptionsOpts = {
      rpName: tenancy.project.display_name,
      rpID: "THIS_VALUE_WILL_BE_REPLACED.example.com", // HACK: will be overridden in the frontend to be the actual domain, this is a temporary solution until we have a primary authentication domain
      // Here we set the userId to the user's id, this will cause to have the browser always store only one passkey per user! (browser stores one passkey per userId/rpID pair)
      userID: isoUint8Array.fromUTF8String(user.id),
      userName: user.display_name || user.primary_email || "Hexclave User",
      challenge: getEnvVariable("STACK_ENABLE_HARDCODED_PASSKEY_CHALLENGE_FOR_TESTING", "") ? isoUint8Array.fromUTF8String("MOCK") : undefined,
      userDisplayName: user.display_name || user.primary_email || "Hexclave User",
      // Force passkey (discoverable/resident)
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      timeout: REGISTRATION_TIMEOUT_MS,
    };

    const registrationOptionsRaw = await generateRegistrationOptions(opts);
    const registrationHints = registrationOptionsRaw["hints"];
    const registrationOptions = Array.isArray(registrationHints) && registrationHints.length === 0
      ? (() => {
        const optionsWithoutHints = { ...registrationOptionsRaw };
        Reflect.deleteProperty(optionsWithoutHints, "hints");
        return optionsWithoutHints;
      })()
      : registrationOptionsRaw;

    const { code } = await registerVerificationCodeHandler.createCode({
      tenancy,
      method: {},
      expiresInMs: REGISTRATION_TIMEOUT_MS + 5000,
      data: {
        userHandle: registrationOptions.user.id,
        challenge: registrationOptions.challenge
      },
      callbackUrl: undefined
    });


    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        options_json: registrationOptions,
        code: code,
      },
    };
  },
});

