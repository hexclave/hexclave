import { it } from "../../../../../helpers";
import { Auth, ContactChannels, backendContext, bumpEmailAddress, createMailbox, niceBackendFetch } from "../../../../backend-helpers";

it("create contact channel on the client", async ({ expect }) => {
  await Auth.Otp.signIn();
  const mailbox = createMailbox();
  const response = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: mailbox.emailAddress,
      type: "email",
      used_for_auth: true,
      user_id: "me",
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "id": "<stripped UUID>",
        "is_primary": false,
        "is_verified": false,
        "type": "email",
        "used_for_auth": true,
        "user_id": "<stripped UUID>",
        "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "id": "<stripped UUID>",
            "is_primary": true,
            "is_verified": true,
            "type": "email",
            "used_for_auth": true,
            "user_id": "<stripped UUID>",
            "value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
          },
          {
            "id": "<stripped UUID>",
            "is_primary": false,
            "is_verified": false,
            "type": "email",
            "used_for_auth": true,
            "user_id": "<stripped UUID>",
            "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("cannot create duplicate contact channels", async ({ expect }) => {
  await Auth.Otp.signIn();
  const mailbox = createMailbox();

  await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: mailbox.emailAddress,
      type: "email",
      used_for_auth: true,
      user_id: "me",
    }
  });

  const response2 = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: mailbox.emailAddress,
      type: "email",
      used_for_auth: true,
      user_id: "me",
    }
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Contact channel already exists",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("create contact channel on the server", async ({ expect }) => {
  const { userId } = await Auth.Otp.signIn();
  const mailbox = createMailbox();
  const response = await niceBackendFetch(`/api/v1/contact-channels`, {
    accessType: "server",
    method: "POST",
    body: {
      value: mailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      is_verified: true,
      user_id: userId,
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "id": "<stripped UUID>",
        "is_primary": false,
        "is_verified": true,
        "type": "email",
        "used_for_auth": false,
        "user_id": "<stripped UUID>",
        "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const userResponse = await niceBackendFetch(`/api/v1/contact-channels?user_id=${userId}`, {
    accessType: "server",
  });
  expect(userResponse.body).toMatchInlineSnapshot(`
    {
      "is_paginated": false,
      "items": [
        {
          "id": "<stripped UUID>",
          "is_primary": true,
          "is_verified": true,
          "type": "email",
          "used_for_auth": true,
          "user_id": "<stripped UUID>",
          "value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        },
        {
          "id": "<stripped UUID>",
          "is_primary": false,
          "is_verified": true,
          "type": "email",
          "used_for_auth": false,
          "user_id": "<stripped UUID>",
          "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
        },
      ],
    }
  `);
});


it("delete contact channel on the client", async ({ expect }) => {
  await Auth.Otp.signIn();

  const meResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
  });
  expect(meResponse.body.contact_channels).toMatchInlineSnapshot(`undefined`);

  const contactChannelId = meResponse.body.items[0].id;

  const deleteResponse = await niceBackendFetch(`/api/v1/contact-channels/me/${contactChannelId}`, {
    accessType: "client",
    method: "DELETE",
  });
  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const meResponse2 = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
  });
  expect(meResponse2.body).toMatchInlineSnapshot(`
    {
      "auth_with_email": true,
      "client_metadata": null,
      "client_read_only_metadata": null,
      "display_name": null,
      "external_auth_providers": [],
      "has_password": false,
      "id": "<stripped UUID>",
      "is_anonymous": false,
      "is_restricted": false,
      "oauth_providers": [],
      "otp_auth_enabled": true,
      "passkey_auth_enabled": false,
      "primary_email": null,
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
    }
  `);
});

it("cannot delete a contact channel that doesn't exist", async ({ expect }) => {
  await Auth.Otp.signIn();

  const deleteResponse = await niceBackendFetch("/api/v1/contact-channels/me/031448ab-178b-4d43-b31b-28f16c3c52a9", {
    accessType: "client",
    method: "DELETE",
  });
  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Contact channel not found",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("lists current user's contact channels on the client", async ({ expect }) => {
  await Auth.Otp.signIn();

  const response = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "id": "<stripped UUID>",
            "is_primary": true,
            "is_verified": true,
            "type": "email",
            "used_for_auth": true,
            "user_id": "<stripped UUID>",
            "value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});


it("cannot list contact channels that is not from the current user on the client", async ({ expect }) => {
  await Auth.Otp.signIn();

  const response = await niceBackendFetch("/api/v1/contact-channels?user_id=031448ab-178b-4d43-b31b-28f16c3c52a9", {
    accessType: "client",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "Client can only list contact channels for their own user.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("login with a newly created contact channel", async ({ expect }) => {
  await Auth.Otp.signIn();
  const newMailbox = await bumpEmailAddress();

  const ccResponse = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: newMailbox.emailAddress,
      type: "email",
      used_for_auth: true,
      user_id: "me",
    }
  });

  const response1 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  // make sure the email is by default not verified
  expect(response1.body.items.find((cc: any) => cc.value === newMailbox.emailAddress)?.is_verified).toBe(false);

  // send verification code
  await ContactChannels.verify({ contactChannelId: ccResponse.body.id });

  const response2 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  // make sure the email is by default not verified
  expect(response2.body.items.find((cc: any) => cc.value === newMailbox.emailAddress)?.is_verified).toBe(true);

  await Auth.Otp.signIn();

  const response3 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response3.body.items.length).toBe(2);
});

it("creates a new account when login with a contact channel that is not used for auth", async ({ expect }) => {
  await Auth.Otp.signIn();
  const newMailbox = createMailbox();

  await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: newMailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      user_id: "me",
    }
  });

  const response1 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response1.body.items.find((cc: any) => cc.value === newMailbox.emailAddress)).toMatchInlineSnapshot(`
    {
      "id": "<stripped UUID>",
      "is_primary": false,
      "is_verified": false,
      "type": "email",
      "used_for_auth": false,
      "user_id": "<stripped UUID>",
      "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
    }
  `);

  backendContext.set({ mailbox: newMailbox });
  await Auth.Otp.signIn();

  const response2 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  // should be a new account
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "id": "<stripped UUID>",
            "is_primary": true,
            "is_verified": true,
            "type": "email",
            "used_for_auth": true,
            "user_id": "<stripped UUID>",
            "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should update contact channel used for auth to true even if that contact channel is already a primary channel", async ({ expect }) => {
  await Auth.Otp.signIn();
  const newMailbox = createMailbox();

  // Create a new contact channel
  const createResponse = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: newMailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      user_id: "me",
    }
  });
  const newChannelId = createResponse.body.id;

  // Verify the new contact channel is not used for auth
  const response1 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response1.body.items.find((cc: any) => cc.id === newChannelId)).toMatchInlineSnapshot(`
    {
      "id": "<stripped UUID>",
      "is_primary": false,
      "is_verified": false,
      "type": "email",
      "used_for_auth": false,
      "user_id": "<stripped UUID>",
      "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
    }
  `);

  // Update the contact channel to be used for auth
  await niceBackendFetch(`/api/v1/contact-channels/me/${newChannelId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      used_for_auth: true,
    }
  });

  // Verify the contact channel is now used for auth
  const response2 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response2.body.items.find((cc: any) => cc.id === newChannelId)).toMatchInlineSnapshot(`
    {
      "id": "<stripped UUID>",
      "is_primary": false,
      "is_verified": false,
      "type": "email",
      "used_for_auth": true,
      "user_id": "<stripped UUID>",
      "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
    }
  `);
});

it("updates contact channel used for auth", async ({ expect }) => {
  await Auth.Otp.signIn();
  const newMailbox = createMailbox();

  // Create a new contact channel
  const createResponse = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: newMailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      user_id: "me",
    }
  });
  const newChannelId = createResponse.body.id;

  // Verify the new contact channel is not used for auth
  const response1 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response1.body.items.find((cc: any) => cc.id === newChannelId)).toMatchInlineSnapshot(`
    {
      "id": "<stripped UUID>",
      "is_primary": false,
      "is_verified": false,
      "type": "email",
      "used_for_auth": false,
      "user_id": "<stripped UUID>",
      "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
    }
  `);

  // Update the contact channel to be used for auth
  await niceBackendFetch(`/api/v1/contact-channels/me/${newChannelId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      used_for_auth: true,
    }
  });

  // Verify the contact channel is now used for auth
  const response2 = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
    method: "GET",
  });
  expect(response2.body.items.find((cc: any) => cc.id === newChannelId)).toMatchInlineSnapshot(`
    {
      "id": "<stripped UUID>",
      "is_primary": false,
      "is_verified": false,
      "type": "email",
      "used_for_auth": true,
      "user_id": "<stripped UUID>",
      "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
    }
  `);
});

it("updates contact channel primary status", async ({ expect }) => {
  await Auth.Otp.signIn();
  const newMailbox = createMailbox();

  const response = await ContactChannels.getTheOnlyContactChannel();
  expect(response.is_primary).toBe(true);

  // Create two new contact channels
  const createResponse1 = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: newMailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      user_id: "me",
    }
  });
  const newChannelId1 = createResponse1.body.id;

  const updateResponse2 = await niceBackendFetch(`/api/v1/contact-channels/me/${newChannelId1}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      is_primary: true,
    }
  });
  expect(updateResponse2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "id": "<stripped UUID>",
        "is_primary": true,
        "is_verified": false,
        "type": "email",
        "used_for_auth": false,
        "user_id": "<stripped UUID>",
        "value": "mailbox-1--<stripped UUID>@stack-generated.example.com",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Verify the first contact channel is no longer primary
  const response2 = await ContactChannels.listAllCurrentUserContactChannels();
  expect(response2.find((cc: any) => cc.id === newChannelId1)?.is_primary).toBe(true);

  const meResponse = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
  });
  expect(meResponse.body).toMatchInlineSnapshot(`
    {
      "auth_with_email": true,
      "client_metadata": null,
      "client_read_only_metadata": null,
      "display_name": null,
      "external_auth_providers": [],
      "has_password": false,
      "id": "<stripped UUID>",
      "is_anonymous": false,
      "is_restricted": false,
      "oauth_providers": [],
      "otp_auth_enabled": true,
      "passkey_auth_enabled": false,
      "primary_email": "mailbox-1--<stripped UUID>@stack-generated.example.com",
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
    }
  `);
});

it("sets a primary contact channel to non-primary", async ({ expect }) => {
  await Auth.Otp.signIn();

  const response = await ContactChannels.getTheOnlyContactChannel();
  expect(response.is_primary).toBe(true);

  const updateResponse = await niceBackendFetch(`/api/v1/contact-channels/me/${response.id}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      is_primary: false,
    }
  });
  expect(updateResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "id": "<stripped UUID>",
        "is_primary": false,
        "is_verified": true,
        "type": "email",
        "used_for_auth": true,
        "user_id": "<stripped UUID>",
        "value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await ContactChannels.getTheOnlyContactChannel();
  expect(response2.is_primary).toBe(false);

  const meResponse = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
  });
  expect(meResponse.body).toMatchInlineSnapshot(`
    {
      "auth_with_email": true,
      "client_metadata": null,
      "client_read_only_metadata": null,
      "display_name": null,
      "external_auth_providers": [],
      "has_password": false,
      "id": "<stripped UUID>",
      "is_anonymous": false,
      "is_restricted": false,
      "oauth_providers": [],
      "otp_auth_enabled": true,
      "passkey_auth_enabled": false,
      "primary_email": null,
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
    }
  `);
});

it("should create a contact channel as primary and demote existing primary", async ({ expect }) => {
  await Auth.Otp.signIn();

  // List current channels - the OTP sign-in creates a primary email
  const beforeResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
  });
  const originalPrimaryChannel = beforeResponse.body.items.find((c: any) => c.is_primary);
  expect(originalPrimaryChannel).toBeDefined();
  expect(originalPrimaryChannel.is_primary).toBe(true);

  // Create a new contact channel and set it as primary
  const mailbox = createMailbox();
  const createResponse = await niceBackendFetch("/api/v1/contact-channels", {
    accessType: "client",
    method: "POST",
    body: {
      value: mailbox.emailAddress,
      type: "email",
      used_for_auth: false,
      user_id: "me",
      is_primary: true,
    }
  });
  expect(createResponse.status).toBe(201);
  expect(createResponse.body.is_primary).toBe(true);

  // List channels again - the new channel should be primary, old one demoted
  const afterResponse = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
    accessType: "client",
  });

  const newPrimaryChannel = afterResponse.body.items.find((c: any) => c.value === mailbox.emailAddress);
  const oldChannel = afterResponse.body.items.find((c: any) => c.id === originalPrimaryChannel.id);

  expect(newPrimaryChannel.is_primary).toBe(true);
  expect(oldChannel.is_primary).toBe(false);
});
