import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { it } from "../../../../../helpers";
import { Auth, ContactChannels, backendContext, createMailbox, niceBackendFetch } from "../../../../backend-helpers";

it("should verify user's email", async ({ expect }) => {
  await Auth.Password.signUpWithEmail({ sendVerificationEmail: true });
  const userResponse1 = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(userResponse1.body.primary_email_verified).toBe(false);
  await ContactChannels.verify();
  const userResponse2 = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(userResponse2.body.primary_email_verified).toBe(true);
});

it("each verification code that was already requested can be used exactly once", async ({ expect }) => {
  // note: send-verification-code checks that you didn't already verify the email when you send the verification code, but if you request multiple at the same time you should be able to use them all

  // Batch-wait for the signup code and the two explicit verification codes.
  await Auth.Password.signUpWithEmail({ sendVerificationEmail: true, waitForVerificationEmail: false });

  // Fire both send-verification-code requests without waiting for delivery
  const contactChannelId = (await ContactChannels.getTheOnlyContactChannel()).id;
  const sendRes1 = await niceBackendFetch(`/api/v1/contact-channels/me/${contactChannelId}/send-verification-code`, {
    method: "POST",
    accessType: "client",
    body: { callback_url: "http://localhost:12345/some-callback-url" },
  });
  expect(sendRes1).toMatchObject({ status: 200 });
  const sendRes2 = await niceBackendFetch(`/api/v1/contact-channels/me/${contactChannelId}/send-verification-code`, {
    method: "POST",
    accessType: "client",
    body: { callback_url: "http://localhost:12345/some-callback-url" },
  });
  expect(sendRes2).toMatchObject({ status: 200 });

  const mailbox = backendContext.value.mailbox;
  const verifyMessages = await mailbox.waitForMessagesWithSubjectCount("Verify your email", 3);
  const verificationCodes = verifyMessages.map((message) => message.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Verification code not found"));
  expect(verificationCodes).toHaveLength(3);

  for (const code of verificationCodes) {
    const response1 = await niceBackendFetch("/api/v1/contact-channels/verify", {
      method: "POST",
      accessType: "client",
      body: {
        code,
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/contact-channels/verify", {
      method: "POST",
      accessType: "client",
      body: {
        code,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 409,
        "body": {
          "code": "VERIFICATION_CODE_ALREADY_USED",
          "error": "The verification link has already been used.",
        },
        "headers": Headers {
          "x-stack-known-error": "VERIFICATION_CODE_ALREADY_USED",
          <some fields may have been hidden>,
        },
      }
    `);
  }
});

it("should not allow verify a code that doesn't exist", async ({ expect }) => {
  await Auth.Password.signUpWithEmail();
  const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: {
      code: "invalid-attempt-code-123123123123123123123123",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "VERIFICATION_CODE_NOT_FOUND",
        "error": "The verification code does not exist for this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "VERIFICATION_CODE_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow verification of a code that is sent from a different endpoint", async ({ expect }) => {
  await Auth.Otp.sendSignInCode();
  const mailbox = backendContext.value.mailbox;
  const messages = await mailbox.waitForMessagesWithSubject("Sign in");
  const verifyMessage = messages.find((message) => message.subject.includes("Sign in"));
  const verificationCode = verifyMessage?.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Verification code not found");

  // Try to verify the magic link code using the contact channels verification endpoint
  const verifyResponse = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: {
      code: verificationCode,
    },
  });

  // Expect the verification to fail
  expect(verifyResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "VERIFICATION_CODE_NOT_FOUND",
        "error": "The verification code does not exist for this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "VERIFICATION_CODE_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

async function signUpWithPasswordAndGetVerificationCode() {
  const signUp = await Auth.Password.signUpWithEmail({ sendVerificationEmail: true });
  const messages = await backendContext.value.mailbox.waitForMessagesWithSubject("Verify your email");
  const message = messages.findLast((message) => message.subject.includes("Verify your email")) ?? throwErr("Verification code message not found");
  const code = message.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Verification code not found");
  return { ...signUp, code, userAuth: backendContext.value.userAuth };
}

async function isPrimaryEmailVerified(userAuth: typeof backendContext.value.userAuth) {
  return await backendContext.with({ userAuth }, async () => {
    const response = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
    return response.body.primary_email_verified;
  });
}

it("verification email warns the recipient not to click the link if they did not sign up", async ({ expect }) => {
  await Auth.Password.signUpWithEmail({ sendVerificationEmail: true });
  const messages = await backendContext.value.mailbox.waitForMessagesWithSubject("Verify your email");
  expect(messages[0].body?.text).toContain("do not click this button. Someone may have signed up with your email address.");
});

it("requires the account's password when require_password_if_set is passed and the user is signed out", async ({ expect }) => {
  const { code, password, userAuth } = await signUpWithPasswordAndGetVerificationCode();
  backendContext.set({ userAuth: null });

  const withoutPassword = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, require_password_if_set: true },
  });
  expect(withoutPassword).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "EMAIL_VERIFICATION_REQUIRES_PASSWORD",
        "error": "This account has a password. Enter the account's password to verify this e-mail.",
      },
      "headers": Headers {
        "x-stack-known-error": "EMAIL_VERIFICATION_REQUIRES_PASSWORD",
        <some fields may have been hidden>,
      },
    }
  `);

  const wrongPassword = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, require_password_if_set: true, password: "definitely-not-the-password" },
  });
  expect(wrongPassword).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PASSWORD_CONFIRMATION_MISMATCH",
        "error": "Passwords do not match.",
      },
      "headers": Headers {
        "x-stack-known-error": "PASSWORD_CONFIRMATION_MISMATCH",
        <some fields may have been hidden>,
      },
    }
  `);
  expect(await isPrimaryEmailVerified(userAuth)).toBe(false);

  // Neither failed attempt used up the code
  const correctPassword = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, require_password_if_set: true, password },
  });
  expect(correctPassword).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await isPrimaryEmailVerified(userAuth)).toBe(true);
});

it("checks the password whenever one is passed, even without require_password_if_set", async ({ expect }) => {
  const { code, userAuth } = await signUpWithPasswordAndGetVerificationCode();
  backendContext.set({ userAuth: null });

  const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, password: "definitely-not-the-password" },
  });
  expect(response.body.code).toBe("PASSWORD_CONFIRMATION_MISMATCH");
  expect(await isPrimaryEmailVerified(userAuth)).toBe(false);
});

it("does not require the password when signed in as the account being verified", async ({ expect }) => {
  const { code, userAuth } = await signUpWithPasswordAndGetVerificationCode();

  const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, require_password_if_set: true },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await isPrimaryEmailVerified(userAuth)).toBe(true);
});

it("still requires the password when signed in as a different account", async ({ expect }) => {
  const { code, userAuth } = await signUpWithPasswordAndGetVerificationCode();
  backendContext.set({ mailbox: createMailbox() });
  await Auth.Password.signUpWithEmail();

  const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code, require_password_if_set: true },
  });
  expect(response.body.code).toBe("EMAIL_VERIFICATION_REQUIRES_PASSWORD");
  expect(await isPrimaryEmailVerified(userAuth)).toBe(false);
});

it("keeps verifying without a password for clients that don't pass require_password_if_set", async ({ expect }) => {
  const { code, userAuth } = await signUpWithPasswordAndGetVerificationCode();
  backendContext.set({ userAuth: null });

  const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
    method: "POST",
    accessType: "client",
    body: { code },
  });
  expect(response.status).toBe(200);
  expect(await isPrimaryEmailVerified(userAuth)).toBe(true);
});
