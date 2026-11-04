import { it } from "../../../../../helpers";
import { Auth, Project, backendContext, createMailbox, generateTestPhoneNumber, mockTurnstileTokens, niceBackendFetch, waitForSmsCode } from "../../../../backend-helpers";

async function createPhoneContactChannel(phoneNumber: string, options: { usedForAuth?: boolean, accessType?: "client" | "server", isVerified?: boolean } = {}) {
  return await niceBackendFetch("/api/v1/contact-channels", {
    accessType: options.accessType ?? "client",
    method: "POST",
    body: {
      user_id: "me",
      type: "phone",
      value: phoneNumber,
      used_for_auth: options.usedForAuth ?? false,
      ...(options.isVerified !== undefined ? { is_verified: options.isVerified } : {}),
    },
  });
}

async function sendPhoneVerificationCode(contactChannelId: string) {
  return await niceBackendFetch(`/api/v1/contact-channels/me/${contactChannelId}/send-sms-verification-code`, {
    accessType: "client",
    method: "POST",
    body: {},
  });
}

it("should create a phone contact channel on the client", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();

  const response = await createPhoneContactChannel(phoneNumber);
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({
    type: "phone",
    value: phoneNumber,
    is_primary: false,
    is_verified: false,
    used_for_auth: false,
  });

  // the primary phone number of the user is unaffected, since the new channel is not primary
  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(userResponse.body.primary_phone_number).toBe(null);
  // the primary email is unaffected too
  expect(userResponse.body.primary_email).toBe(backendContext.value.mailbox.emailAddress);
});

it("should reject phone contact channels that are not in E.164 format", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();

  for (const value of ["5555550100", "+1 555 555 0100", "johndoe@example.com"]) {
    const response = await createPhoneContactChannel(value);
    expect(response.status, value).toBe(400);
  }
});

it("should reject updating a phone contact channel to a value that is not in E.164 format", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const createResponse = await createPhoneContactChannel(generateTestPhoneNumber());

  const response = await niceBackendFetch(`/api/v1/contact-channels/me/${createResponse.body.id}`, {
    accessType: "client",
    method: "PATCH",
    body: { value: "johndoe@example.com" },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Phone number must be in E.164 format, eg. +15555550100",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject changing the type of a contact channel", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const listResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", { accessType: "client" });
  const emailChannelId = listResponse.body.items[0].id;

  const response = await niceBackendFetch(`/api/v1/contact-channels/me/${emailChannelId}`, {
    accessType: "client",
    method: "PATCH",
    body: { type: "phone", value: generateTestPhoneNumber() },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "The type of a contact channel cannot be changed. Delete it and create a new contact channel instead.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should keep a phone contact channel verified when updating it to its current value", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();
  const createResponse = await createPhoneContactChannel(phoneNumber, { accessType: "server", isVerified: true });
  expect(createResponse.body.is_verified).toBe(true);

  const response = await niceBackendFetch(`/api/v1/contact-channels/me/${createResponse.body.id}`, {
    accessType: "client",
    method: "PATCH",
    body: { value: phoneNumber },
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ value: phoneNumber, is_verified: true });
});

it("should unverify a phone contact channel when updating it to a different value", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const createResponse = await createPhoneContactChannel(generateTestPhoneNumber(), { accessType: "server", isVerified: true });
  const newPhoneNumber = generateTestPhoneNumber();

  const response = await niceBackendFetch(`/api/v1/contact-channels/me/${createResponse.body.id}`, {
    accessType: "client",
    method: "PATCH",
    body: { value: newPhoneNumber },
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ value: newPhoneNumber, is_verified: false });
});

it("should allow a primary phone number alongside a primary email", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();
  const createResponse = await createPhoneContactChannel(phoneNumber);

  const updateResponse = await niceBackendFetch(`/api/v1/contact-channels/me/${createResponse.body.id}`, {
    accessType: "client",
    method: "PATCH",
    body: { is_primary: true },
  });
  expect(updateResponse.status).toBe(200);

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(userResponse.body).toMatchObject({
    primary_email: backendContext.value.mailbox.emailAddress,
    primary_email_verified: true,
    primary_phone_number: phoneNumber,
    primary_phone_number_verified: false,
  });
});

it("should not allow two users to use the same phone number for auth", async ({ expect }) => {
  const phoneNumber = generateTestPhoneNumber();
  await Auth.fastSignUpWithEmail();
  const response1 = await createPhoneContactChannel(phoneNumber, { usedForAuth: true });
  expect(response1.status).toBe(201);

  backendContext.set({ mailbox: createMailbox(), userAuth: null });
  await Auth.fastSignUpWithEmail();
  const response2 = await createPhoneContactChannel(phoneNumber, { usedForAuth: true });
  expect(response2.status).toBe(409);
  expect(response2.body.code).toBe("CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE");

  // ...but they can both have it as a non-auth contact channel
  const response3 = await createPhoneContactChannel(phoneNumber, { usedForAuth: false });
  expect(response3.status).toBe(201);
});

it("should verify a phone contact channel with a code sent via SMS", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "sms.server.provider": "test" });
  await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();
  const createResponse = await createPhoneContactChannel(phoneNumber);

  const sendResponse = await sendPhoneVerificationCode(createResponse.body.id);
  expect(sendResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "nonce": <stripped field 'nonce'> },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  const code = await waitForSmsCode(phoneNumber, "verification code");

  const verifyResponse = await niceBackendFetch("/api/v1/contact-channels/verify-phone-number", {
    accessType: "client",
    method: "POST",
    body: { code: code + sendResponse.body.nonce },
  });
  expect(verifyResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const channelResponse = await niceBackendFetch(`/api/v1/contact-channels/me/${createResponse.body.id}`, { accessType: "client" });
  expect(channelResponse.body.is_verified).toBe(true);

  // a verified phone number can't be verified again
  const sendAgainResponse = await sendPhoneVerificationCode(createResponse.body.id);
  expect(sendAgainResponse.status).toBe(400);
});

it("should let users sign in with a phone number after adding and verifying it", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.Sms.enableSmsSignIn();
  const { userId } = await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();
  const createResponse = await createPhoneContactChannel(phoneNumber, { usedForAuth: true });

  const sendResponse = await sendPhoneVerificationCode(createResponse.body.id);
  const code = await waitForSmsCode(phoneNumber, "verification code");
  const verifyResponse = await niceBackendFetch("/api/v1/contact-channels/verify-phone-number", {
    accessType: "client",
    method: "POST",
    body: { code: code + sendResponse.body.nonce },
  });
  expect(verifyResponse.status).toBe(200);

  backendContext.set({ userAuth: null });
  const signInResult = await Auth.Sms.signIn(phoneNumber);
  expect(signInResult.userId).toBe(userId);
  expect(signInResult.signInResponse.body.is_new_user).toBe(false);
});

it("should not send phone verification codes to email contact channels", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "sms.server.provider": "test" });
  await Auth.fastSignUpWithEmail();
  const listResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", { accessType: "client" });

  const response = await sendPhoneVerificationCode(listResponse.body.items[0].id);
  expect(response.status).toBe(404);
});

it("should not send phone verification codes if no SMS provider is configured", async ({ expect }) => {
  await Auth.fastSignUpWithEmail();
  const createResponse = await createPhoneContactChannel(generateTestPhoneNumber());

  const response = await sendPhoneVerificationCode(createResponse.body.id);
  expect(response.status).toBe(400);
});

it("should set the primary phone number with the users API", async ({ expect }) => {
  await Project.createAndSwitch();
  const phoneNumber = generateTestPhoneNumber();
  const newPhoneNumber = generateTestPhoneNumber();

  const createResponse = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: {
      primary_phone_number: phoneNumber,
      primary_phone_number_verified: true,
    },
  });
  expect(createResponse.status).toBe(201);
  expect(createResponse.body).toMatchObject({
    primary_phone_number: phoneNumber,
    primary_phone_number_verified: true,
    primary_phone_number_auth_enabled: false,
  });
  const userId = createResponse.body.id;

  // changing the phone number demotes the old one and resets the verification status
  const updateResponse = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "server",
    method: "PATCH",
    body: { primary_phone_number: newPhoneNumber },
  });
  expect(updateResponse.body).toMatchObject({
    primary_phone_number: newPhoneNumber,
    primary_phone_number_verified: false,
    primary_phone_number_auth_enabled: false,
  });
  const listResponse = await niceBackendFetch(`/api/v1/contact-channels?user_id=${userId}`, { accessType: "server" });
  expect(listResponse.body.items.map((c: any) => ({ value: c.value, is_primary: c.is_primary, is_verified: c.is_verified }))).toEqual([
    { value: phoneNumber, is_primary: false, is_verified: true },
    { value: newPhoneNumber, is_primary: true, is_verified: false },
  ]);

  // switching back to the existing channel preserves its verification status
  const switchBackResponse = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "server",
    method: "PATCH",
    body: { primary_phone_number: phoneNumber },
  });
  expect(switchBackResponse.body).toMatchObject({
    primary_phone_number: phoneNumber,
    primary_phone_number_verified: true,
  });

  // setting it to null demotes it without deleting it
  const removeResponse = await niceBackendFetch(`/api/v1/users/${userId}`, {
    accessType: "server",
    method: "PATCH",
    body: { primary_phone_number: null },
  });
  expect(removeResponse.body).toMatchObject({
    primary_phone_number: null,
    primary_phone_number_verified: false,
    primary_phone_number_auth_enabled: false,
  });
});

it("should reject invalid primary phone number values in the users API", async ({ expect }) => {
  await Project.createAndSwitch();

  const response = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: { primary_phone_number: "555-0100" },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("SCHEMA_ERROR");

  const authWithoutPhoneResponse = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: { primary_phone_number_auth_enabled: true },
  });
  expect(authWithoutPhoneResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "primary_phone_number_auth_enabled cannot be true without primary_phone_number",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should not allow two users to have the same auth-enabled primary phone number in the users API", async ({ expect }) => {
  await Project.createAndSwitch();
  const phoneNumber = generateTestPhoneNumber();

  const response1 = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: { primary_phone_number: phoneNumber, primary_phone_number_auth_enabled: true },
  });
  expect(response1.status).toBe(201);

  const response2 = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
    method: "POST",
    body: { primary_phone_number: phoneNumber, primary_phone_number_auth_enabled: true },
  });
  expect(response2.status).toBe(409);
  expect(response2.body.code).toBe("CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE");
});


it("should enforce the phone verification quota across concurrent requests", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "sms.server.provider": "test" });
  await Auth.fastSignUpWithEmail();
  const channel = await createPhoneContactChannel(generateTestPhoneNumber());
  expect(channel.status).toBe(201);
  const responses = await Promise.all(Array.from({ length: 10 }, async () => await sendPhoneVerificationCode(channel.body.id)));
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
});

it("should share the SMS quota of a phone number between verification and sign-in codes", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.Sms.enableSmsSignIn();
  await Auth.fastSignUpWithEmail();
  const phoneNumber = generateTestPhoneNumber();
  const channel = await createPhoneContactChannel(phoneNumber);
  expect(channel.status).toBe(201);

  for (let i = 0; i < 3; i++) {
    const response = await sendPhoneVerificationCode(channel.body.id);
    expect(response.status, `verification request ${i + 1}`).toBe(200);
  }
  const sendSignInCode = async () => await niceBackendFetch("/api/v1/auth/sms/send-sign-in-code", {
    method: "POST",
    accessType: "client",
    body: { phone_number: phoneNumber, bot_challenge_token: mockTurnstileTokens.smsSignInOk },
  });
  for (let i = 0; i < 2; i++) {
    const response = await sendSignInCode();
    expect(response.status, `sign-in request ${i + 1}`).toBe(200);
  }

  expect(await sendSignInCode()).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 429,
      "body": "Too many codes were requested for this phone number. Please try again later.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await sendPhoneVerificationCode(channel.body.id)).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 429,
      "body": "Too many codes were requested for this phone number. Please try again later.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should limit the number of phone verification codes sent on behalf of the same user", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "sms.server.provider": "test" });
  await Auth.fastSignUpWithEmail();

  // two phone numbers exhaust their per-phone-number quotas, which together make up the per-user quota
  for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
    const channel = await createPhoneContactChannel(generateTestPhoneNumber());
    expect(channel.status).toBe(201);
    for (let i = 0; i < 5; i++) {
      const response = await sendPhoneVerificationCode(channel.body.id);
      expect(response.status, `channel ${channelIndex + 1}, request ${i + 1}`).toBe(200);
    }
  }

  // a third phone number still has its own quota left, but the user doesn't
  const thirdChannel = await createPhoneContactChannel(generateTestPhoneNumber());
  expect(thirdChannel.status).toBe(201);
  expect(await sendPhoneVerificationCode(thirdChannel.body.id)).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 429,
      "body": "Too many SMS codes were requested for this user. Please try again later.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // other users are not affected
  await Auth.fastSignUpWithEmail();
  const otherUserChannel = await createPhoneContactChannel(generateTestPhoneNumber());
  expect((await sendPhoneVerificationCode(otherUserChannel.body.id)).status).toBe(200);
});
