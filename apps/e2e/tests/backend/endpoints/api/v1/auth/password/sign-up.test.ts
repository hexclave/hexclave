import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../../../helpers";
import { Auth, Project, backendContext, bumpEmailAddress, niceBackendFetch } from "../../../../../backend-helpers";

it("should sign up new users", async ({ expect }) => {
  const res = await Auth.Password.signUpWithEmail({
    sendVerificationEmail: true,
    waitForVerificationEmail: false,
  });
  expect(res.signUpResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  // signUpWithEmail already waits for verification email
  const messages = await backendContext.value.mailbox.waitForMessagesWithSubject("Verify your email", { noBody: true });
  expect(messages).toMatchInlineSnapshot(`
    [
      MailboxMessage {
        "from": "Hexclave Dashboard <noreply@example.com>",
        "subject": "Verify your email at Hexclave Dashboard",
        "to": ["<default-mailbox--<stripped UUID>@stack-generated.example.com>"],
        <some fields may have been hidden>,
      },
    ]
  `);
  const response = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": true,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_verified": false,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "display_name": "default-mailbox--<stripped UUID>@stack-generated.example.com's Team",
          "id": "<stripped UUID>",
          "profile_image_url": null,
        },
        "selected_team_id": "<stripped UUID>",
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should sign up without verification callback and not send email", async ({ expect }) => {
  await bumpEmailAddress();
  const mailbox = backendContext.value.mailbox;
  const email = mailbox.emailAddress;
  const password = generateSecureRandomString();

  const response = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email,
      password,
    },
  });

  expect(response).toMatchObject({
    status: 200,
    body: {
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      user_id: expect.any(String),
    },
  });

  await wait(5000);
  const messages = await mailbox.fetchMessages({ noBody: true });
  expect(messages).toMatchInlineSnapshot(`[]`);
});

it("should not sign up new users if verification callback url is not valid", async ({ expect }) => {
  const mailbox = backendContext.value.mailbox;
  const email = mailbox.emailAddress;
  const password = generateSecureRandomString();
  const response = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email,
      password,
      verification_callback_url: "http://invalid-domain.com",
    },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "REDIRECT_URL_NOT_WHITELISTED",
        "details": { "redirect_url": "http://invalid-domain.com" },
        "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
      },
      "headers": Headers {
        "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow signing up with an e-mail that already exists", async ({ expect }) => {
  await Auth.Password.signUpWithEmail();
  const res2 = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: generateSecureRandomString(),
      verification_callback_url: "http://localhost:12345",
    },
  });
  expect(res2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 409,
      "body": {
        "code": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
        "details": {
          "contact_channel_value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
          "type": "email",
          "would_work_if_email_was_verified": false,
        },
        "error": "This email \\"(default-mailbox--<stripped UUID>@stack-generated.example.com)\\" is already used for authentication by another account.",
      },
      "headers": Headers {
        "x-stack-known-error": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow signing up if credentials are disabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { credential_enabled: false } });
  const res2 = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: generateSecureRandomString(),
      verification_callback_url: "http://localhost:12345",
    },
  });
  expect(res2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PASSWORD_AUTHENTICATION_NOT_ENABLED",
        "error": "Password authentication is not enabled for this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "PASSWORD_AUTHENTICATION_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow signing up if sign ups are disabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { sign_up_enabled: false, credential_enabled: true } });
  const res2 = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: generateSecureRandomString(),
      verification_callback_url: "http://localhost:12345",
    },
  });
  expect(res2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SIGN_UP_NOT_ENABLED",
        "error": "Creation of new accounts is not enabled for this project. Please ask the project owner to enable it.",
      },
      "headers": Headers {
        "x-stack-known-error": "SIGN_UP_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("cannot use empty password to sign up", async ({ expect }) => {
  const res = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: "",
      verification_callback_url: "http://localhost:12345",
    },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PASSWORD_TOO_SHORT",
        "details": { "min_length": 8 },
        "error": "Password too short. Minimum length is 8.",
      },
      "headers": Headers {
        "x-stack-known-error": "PASSWORD_TOO_SHORT",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("cannot use a password that is too short to sign up", async ({ expect }) => {
  const res = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: "short",
      verification_callback_url: "http://localhost:12345",
    },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PASSWORD_TOO_SHORT",
        "details": { "min_length": 8 },
        "error": "Password too short. Minimum length is 8.",
      },
      "headers": Headers {
        "x-stack-known-error": "PASSWORD_TOO_SHORT",
        <some fields may have been hidden>,
      },
    }
  `);
});

it.todo("should create a team for newly created users if configured as such");

it.todo("should not create a team for newly created users if not configured as such");
