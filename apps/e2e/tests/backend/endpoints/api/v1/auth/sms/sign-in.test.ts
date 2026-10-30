import { it } from "../../../../../../helpers";
import { Auth, Project, backendContext, generateTestPhoneNumber, mockTurnstileTokens, niceBackendFetch } from "../../../../../backend-helpers";

async function sendSignInCodeRaw(phoneNumber: string) {
  return await niceBackendFetch("/api/v1/auth/sms/send-sign-in-code", {
    method: "POST",
    accessType: "client",
    body: {
      phone_number: phoneNumber,
      bot_challenge_token: mockTurnstileTokens.smsSignInOk,
    },
  });
}

it("should sign up new users with a verified, auth-enabled primary phone number", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const res = await Auth.Sms.signIn(phoneNumber);
  expect(res.signInResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "is_new_user": true,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "server" });
  expect(userResponse.body).toMatchObject({
    id: res.userId,
    primary_email: null,
    primary_phone_number: phoneNumber,
    primary_phone_number_verified: true,
    primary_phone_number_auth_enabled: true,
    otp_auth_enabled: true,
  });

  const contactChannelsResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", { accessType: "client" });
  expect(contactChannelsResponse.body.items).toEqual([
    expect.objectContaining({
      type: "phone",
      value: phoneNumber,
      is_primary: true,
      is_verified: true,
      used_for_auth: true,
    }),
  ]);
});

it("should sign in existing users with the same phone number", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const res1 = await Auth.Sms.signIn(phoneNumber);
  backendContext.set({ userAuth: null });
  const res2 = await Auth.Sms.signIn(phoneNumber);
  expect(res2.signInResponse.body.is_new_user).toBe(false);
  expect(res2.userId).toBe(res1.userId);
});

it("should sign in users created with the server API with a verified phone number, and add the OTP auth method", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const createResponse = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: {
      primary_phone_number: phoneNumber,
      primary_phone_number_verified: true,
      primary_phone_number_auth_enabled: true,
    },
  });
  expect(createResponse.status).toBe(201);
  expect(createResponse.body.otp_auth_enabled).toBe(false);

  const res = await Auth.Sms.signIn(phoneNumber);
  expect(res.signInResponse.body.is_new_user).toBe(false);
  expect(res.userId).toBe(createResponse.body.id);

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "server" });
  expect(userResponse.body.otp_auth_enabled).toBe(true);
});

it("should not send a code to a phone number that is used for auth but not verified", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const createResponse = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: {
      primary_phone_number: phoneNumber,
      primary_phone_number_verified: false,
      primary_phone_number_auth_enabled: true,
    },
  });
  expect(createResponse.status).toBe(201);

  const response = await sendSignInCodeRaw(phoneNumber);
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({
    code: "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
    details: {
      type: "phone",
      contact_channel_value: phoneNumber,
      would_work_if_email_was_verified: true,
    },
  });
});

it("should not sign up new users if sign-up is disabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { sign_up_enabled: false } });
  await Auth.Sms.enableSmsSignIn();

  const response = await sendSignInCodeRaw(generateTestPhoneNumber());
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("SIGN_UP_NOT_ENABLED");
});

it("should reject sending codes if SMS sign-in is not enabled", async ({ expect }) => {
  await Project.createAndSwitch();
  await Project.updateConfig({ "sms.server.provider": "test" });

  const response = await sendSignInCodeRaw(generateTestPhoneNumber());
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "SMS sign-in is not enabled for this project",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject signing in with a code if SMS sign-in was disabled after the code was sent", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const { fullCode } = await Auth.Sms.sendSignInCode(generateTestPhoneNumber());

  await Project.updateConfig({ "auth.sms.allowSignIn": false });

  const response = await niceBackendFetch("/api/v1/auth/sms/sign-in", {
    method: "POST",
    accessType: "client",
    body: { code: fullCode },
  });
  expect(response.status).toBe(403);
});

it("should reject sending codes if no SMS provider is configured", async ({ expect }) => {
  await Project.createAndSwitch();
  await Project.updateConfig({ "auth.sms.allowSignIn": true });

  const response = await sendSignInCodeRaw(generateTestPhoneNumber());
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "SMS sign-in is enabled, but no SMS provider is configured for this project.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject phone numbers that are not in E.164 format", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();

  for (const phoneNumber of ["5555550100", "+1 555 555 0100", "+1-555-555-0100", "not a phone number"]) {
    const response = await sendSignInCodeRaw(phoneNumber);
    expect(response.status, phoneNumber).toBe(400);
    expect(response.body.code, phoneNumber).toBe("SCHEMA_ERROR");
  }
});

it("should not allow reusing a code", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();

  const { fullCode } = await Auth.Sms.signIn(generateTestPhoneNumber());
  const response = await niceBackendFetch("/api/v1/auth/sms/sign-in", {
    method: "POST",
    accessType: "client",
    body: { code: fullCode },
  });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("VERIFICATION_CODE_ALREADY_USED");
});

it("should reject a wrong code", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();

  const { sendSignInCodeResponse } = await Auth.Sms.sendSignInCode(generateTestPhoneNumber());
  const response = await niceBackendFetch("/api/v1/auth/sms/sign-in", {
    method: "POST",
    accessType: "client",
    body: { code: "000000" + sendSignInCodeResponse.body.nonce },
  });
  expect(response.status).toBe(404);
  expect(response.body.code).toBe("VERIFICATION_CODE_NOT_FOUND");
});

it("should check whether a code is valid without using it", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();

  const { fullCode } = await Auth.Sms.sendSignInCode(generateTestPhoneNumber());
  const checkResponse = await niceBackendFetch("/api/v1/auth/sms/sign-in/check-code", {
    method: "POST",
    accessType: "client",
    body: { code: fullCode },
  });
  expect(checkResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "is_code_valid": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  await Auth.Sms.signInWithCode(fullCode);
});

it("should not accept email sign-in codes on the SMS sign-in endpoint", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.Sms.enableSmsSignIn();

  const { sendSignInCodeResponse } = await Auth.Otp.sendSignInCode();
  const emailCode = await Auth.Otp.getSignInCodeFromMailbox(sendSignInCodeResponse.body.nonce);
  const response = await niceBackendFetch("/api/v1/auth/sms/sign-in", {
    method: "POST",
    accessType: "client",
    body: { code: emailCode },
  });
  expect(response.status).toBe(404);
  expect(response.body.code).toBe("VERIFICATION_CODE_NOT_FOUND");
});

it("should rate-limit the number of codes sent to the same phone number", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  for (let i = 0; i < 5; i++) {
    const response = await sendSignInCodeRaw(phoneNumber);
    expect(response.status, `request ${i + 1}`).toBe(200);
  }
  const response = await sendSignInCodeRaw(phoneNumber);
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 429,
      "body": "Too many codes were requested for this phone number. Please try again later.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // other phone numbers are not affected
  const otherResponse = await sendSignInCodeRaw(generateTestPhoneNumber());
  expect(otherResponse.status).toBe(200);
});

it("should upgrade anonymous users", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const anonymous = await Auth.Anonymous.signUp();
  const res = await Auth.Sms.signIn(phoneNumber);
  expect(res.userId).toBe(anonymous.userId);
  expect(res.signInResponse.body.is_new_user).toBe(true);

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "server" });
  expect(userResponse.body).toMatchObject({
    is_anonymous: false,
    primary_phone_number: phoneNumber,
    primary_phone_number_verified: true,
    primary_phone_number_auth_enabled: true,
  });
});


it("should enforce the SMS quota across concurrent requests", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();
  const responses = await Promise.all(Array.from({ length: 10 }, async () => await sendSignInCodeRaw(phoneNumber)));
  expect(responses.map(response => response.status).sort((a, b) => a - b)).toMatchInlineSnapshot(`
    [
      200,
      200,
      200,
      200,
      200,
      429,
      429,
      429,
      429,
      429,
    ]
  `);
  expect((await sendSignInCodeRaw(generateTestPhoneNumber())).status).toBe(200);
});

async function sendSignInCodeWithBotChallenge(phoneNumber: string, botChallenge: Record<string, string>) {
  return await niceBackendFetch("/api/v1/auth/sms/send-sign-in-code", {
    method: "POST",
    accessType: "client",
    body: {
      phone_number: phoneNumber,
      ...botChallenge,
    },
  });
}

it("should not send a code if the bot challenge token is missing", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const response = await sendSignInCodeWithBotChallenge(generateTestPhoneNumber(), {});
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "BOT_CHALLENGE_FAILED",
        "details": { "message": "A passed bot challenge is required to send an SMS sign-in code." },
        "error": "A passed bot challenge is required to send an SMS sign-in code.",
      },
      "headers": Headers {
        "x-stack-known-error": "BOT_CHALLENGE_FAILED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not send a code if the bot challenge token is invalid and no phase is given", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const response = await sendSignInCodeWithBotChallenge(generateTestPhoneNumber(), {
    bot_challenge_token: mockTurnstileTokens.invalid,
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "BOT_CHALLENGE_FAILED",
        "details": { "message": "A passed bot challenge is required to send an SMS sign-in code." },
        "error": "A passed bot challenge is required to send an SMS sign-in code.",
      },
      "headers": Headers {
        "x-stack-known-error": "BOT_CHALLENGE_FAILED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not send a code if the client claims the bot challenge is unavailable", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const response = await sendSignInCodeWithBotChallenge(generateTestPhoneNumber(), {
    bot_challenge_unavailable: "true",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "BOT_CHALLENGE_FAILED",
        "details": { "message": "A passed bot challenge is required to send an SMS sign-in code." },
        "error": "A passed bot challenge is required to send an SMS sign-in code.",
      },
      "headers": Headers {
        "x-stack-known-error": "BOT_CHALLENGE_FAILED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should require a visible bot challenge if the invisible one fails, and send the code once it passes", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.Sms.enableSmsSignIn();
  const phoneNumber = generateTestPhoneNumber();

  const invisibleResponse = await sendSignInCodeWithBotChallenge(phoneNumber, {
    bot_challenge_token: mockTurnstileTokens.invalid,
    bot_challenge_phase: "invisible",
  });
  expect(invisibleResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 409,
      "body": {
        "code": "BOT_CHALLENGE_REQUIRED",
        "error": "An additional bot challenge is required before sign-up can continue.",
      },
      "headers": Headers {
        "x-stack-known-error": "BOT_CHALLENGE_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);

  const visibleFailedResponse = await sendSignInCodeWithBotChallenge(phoneNumber, {
    bot_challenge_token: mockTurnstileTokens.invalid,
    bot_challenge_phase: "visible",
  });
  expect(visibleFailedResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "BOT_CHALLENGE_FAILED",
        "details": { "message": "Visible bot challenge verification failed" },
        "error": "Visible bot challenge verification failed",
      },
      "headers": Headers {
        "x-stack-known-error": "BOT_CHALLENGE_FAILED",
        <some fields may have been hidden>,
      },
    }
  `);

  const visibleResponse = await sendSignInCodeWithBotChallenge(phoneNumber, {
    bot_challenge_token: mockTurnstileTokens.visibleSmsSignInOk,
    bot_challenge_phase: "visible",
  });
  expect(visibleResponse.status).toBe(200);
});
