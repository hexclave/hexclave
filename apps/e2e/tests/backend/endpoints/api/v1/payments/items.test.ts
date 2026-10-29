import { range } from "@hexclave/shared/dist/utils/arrays";
import { describe, expect } from "vitest";
import { it } from "../../../../../helpers";
import { Auth, InternalProjectKeys, Project, User, backendContext, createMailbox, niceBackendFetch } from "../../../../backend-helpers";

async function updateEnvironmentConfig(config: any) {
  const response = await niceBackendFetch(`/api/latest/internal/config/override/environment`, {
    accessType: "admin",
    method: "PATCH",
    body: { config_override_string: JSON.stringify(config) },
  });
  expect(response.status).toBe(200);
}

describe("without authentication", () => {
  it("should not be able to get item without access type", async ({ expect }) => {
    await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/latest/payments/items/user/user-123/test-item");
    expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 400,
          "body": {
            "code": "ACCESS_TYPE_REQUIRED",
            "error": deindent\`
              You must specify an access level for this Hexclave project. Make sure project API keys are provided (eg. x-hexclave-publishable-client-key) and you set the x-hexclave-access-type header to 'client', 'server', or 'admin'. (The legacy x-stack-* equivalents are also accepted.)
              
              For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
            \`,
          },
          "headers": Headers {
            "x-stack-known-error": "ACCESS_TYPE_REQUIRED",
            <some fields may have been hidden>,
          },
        }
      `);
  });
});

it("should be able to get item information with valid customer and item IDs", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": {
            "display_name": "Test Item",
            "id": "test-item",
            "quantity": 0,
          },
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
});

it("should return ItemNotFound error for non-existent item", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/non-existent-item`, {
    accessType: "client",
  });
  expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 404,
          "body": {
            "code": "ITEM_NOT_FOUND",
            "details": { "item_id": "non-existent-item" },
            "error": "Item with ID \\\"non-existent-item\\\" not found.",
          },
          "headers": Headers {
            "x-stack-known-error": "ITEM_NOT_FOUND",
            <some fields may have been hidden>,
          },
        }
      `);
});

it("should return ItemCustomerTypeDoesNotMatch error for user accessing team item", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "team",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH",
          "details": {
            "actual_customer_type": "user",
            "customer_id": "<stripped UUID>",
            "item_customer_type": "team",
            "item_id": "test-item",
          },
          "error": "The user with ID \\"<stripped UUID>\\" is not a valid customer for the item with ID \\"test-item\\". The item is configured to only be available for team customers, but the customer is a user.",
        },
        "headers": Headers {
          "x-stack-known-error": "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH",
          <some fields may have been hidden>,
        },
      }
    `);
});

it("creates an item quantity change successfully", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const user = await User.create();

  const response = await niceBackendFetch(`/api/latest/payments/items/user/${user.userId}/test-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: {
      delta: 3,
      description: "manual grant",
    },
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({});
});

it("aggregates item quantity changes in item quantity", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const post1 = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: { delta: 2 },
  });
  expect(post1.status).toBe(200);

  const get1 = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(get1.status).toBe(200);
  expect(get1.body.quantity).toBe(2);
});

it("ignores expired changes", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const post = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: { delta: 4, expires_at: new Date(Date.now() - 1000).toISOString() },
  });
  expect(post.status).toBe(200);

  const get = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(get.status).toBe(200);
  expect(get.body.quantity).toBe(0);
});

it("counts a grant with a future expiry in the current balance", async ({ expect }) => {
  // Regression: a manual grant with a future expires_at must count toward the current balance. The
  // item-quantities fold materializes the grant's future-dated expire marker eagerly, so reading the
  // fold's final row (rather than the balance "as of now") would wrongly report the grant as already
  // expired and cause spurious ItemQuantityInsufficientAmount rejections until the expiry passes.
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const post = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: { delta: 4, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  });
  expect(post.status).toBe(200);

  const get = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(get.status).toBe(200);
  expect(get.body.quantity).toBe(4);
});

it("sums multiple non-expired changes", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  for (const q of [2, -1, 5]) {
    const r = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=false`, {
      method: "POST",
      accessType: "admin",
      body: { delta: q },
    });
    expect(r.status).toBe(200);
  }

  const get = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(get.status).toBe(200);
  expect(get.body.quantity).toBe(6);
});

it("rejects quantity deltas outside the 32-bit integer range", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  for (const delta of [5_000_000_000, -5_000_000_000]) {
    const r = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=true`, {
      method: "POST",
      accessType: "admin",
      body: { delta },
    });
    expect(r.status).toBe(400);
  }
});

it("validates item and customer type", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "team-item": {
          displayName: "Team Item",
          customerType: "team",
        },
      },
    },
  });

  const user = await User.create();
  const response = await niceBackendFetch(`/api/latest/payments/items/user/${user.userId}/team-item/update-quantity?allow_negative=true`, {
    method: "POST",
    accessType: "admin",
    body: { delta: 1 },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH",
        "details": {
          "actual_customer_type": "user",
          "customer_id": "<stripped UUID>",
          "item_customer_type": "team",
          "item_id": "team-item",
        },
        "error": "The user with ID \\"<stripped UUID>\\" is not a valid customer for the item with ID \\"team-item\\". The item is configured to only be available for team customers, but the customer is a user.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should error when deducting more quantity than available", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const user = await User.create();

  const response = await niceBackendFetch(`/api/latest/payments/items/user/${user.userId}/test-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: { delta: -1 },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
        "details": {
          "customer_id": "<stripped UUID>",
          "item_id": "test-item",
          "quantity": -1,
        },
        "error": "The item with ID \\"test-item\\" has an insufficient quantity for the customer with ID \\"<stripped UUID>\\". An attempt was made to charge -1 credits.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("allows team admins to be added when item quantity is increased", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  await Auth.fastSignUp();
  const { createProjectResponse } = await Project.create();
  const ownerTeamId: string = createProjectResponse.body.owner_team_id;

  await niceBackendFetch(`/api/v1/payments/items/team/${ownerTeamId}/dashboard_admins/update-quantity?allow_negative=true`, {
    method: "POST",
    accessType: "admin",
    body: {
      delta: 2,
    },
  });

  const itemQuantityResponse = await niceBackendFetch(`/api/v1/payments/items/team/${ownerTeamId}/dashboard_admins`, {
    accessType: "admin",
  });
  expect(itemQuantityResponse.status).toBe(200);
  expect(itemQuantityResponse.body.quantity).toBe(3);

  const itemQuantity = itemQuantityResponse.body.quantity;
  const availableInvitations = itemQuantity - 1;

  const mailboxes = await Promise.all(range(availableInvitations + 1).map(async () => {
    const mailbox = createMailbox();
    const sendInvitationResponse = await niceBackendFetch("/api/v1/team-invitations/send-code", {
      method: "POST",
      accessType: "server",
      body: {
        email: mailbox.emailAddress,
        team_id: ownerTeamId,
        callback_url: "http://localhost:12345/some-callback-url",
      },
    });
    expect(sendInvitationResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "id": "<stripped UUID>",
          "success": true,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    return mailbox;
  }));

  // Pre-fetch all invitation emails in parallel to avoid sequential waits
  const allInvitationMessages = await Promise.all(
    mailboxes.map((mailbox) => mailbox.waitForMessagesWithSubject("join")),
  );

  for (let i = 0; i < mailboxes.length; i++) {
    const mailbox = mailboxes[i];
    backendContext.set({ mailbox: mailbox });
    await Auth.fastSignUp();

    const invitationMessages = allInvitationMessages[i];
    const acceptResponse = await niceBackendFetch("/api/v1/team-invitations/accept", {
      method: "POST",
      accessType: "client",
      body: {
        code: invitationMessages.findLast((m) => m.subject.includes("join"))?.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1],
      },
    });

    if (i < availableInvitations) {
      expect(acceptResponse).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": {},
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
    } else {
      expect(acceptResponse).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 400,
          "body": {
            "code": "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
            "details": {
              "customer_id": "<stripped UUID>",
              "item_id": "dashboard_admins",
              "quantity": -1,
            },
            "error": "The item with ID \\"dashboard_admins\\" has an insufficient quantity for the customer with ID \\"<stripped UUID>\\". An attempt was made to charge -1 credits.",
          },
          "headers": Headers {
            "x-stack-known-error": "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
            <some fields may have been hidden>,
          },
        }
      `);
    }
  }
});

it("should allow negative quantity changes when allow_negative is true", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item/update-quantity?allow_negative=true`, {
    method: "POST",
    accessType: "admin",
    body: { delta: -3 },
  });

  expect(response.status).toBe(200);
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {},
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const getItemResponse = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
  });
  expect(getItemResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "display_name": "Test Item",
        "id": "test-item",
        "quantity": -3,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("supports custom customer type for items (GET and update-quantity)", async ({ expect }) => {
  await Project.createAndSwitch();
  await updateEnvironmentConfig({
    payments: {
      items: {
        "custom-item": {
          displayName: "Custom Item",
          customerType: "custom",
        },
      },
    },
  });

  const customCustomerId = "custom-xyz";

  const getBefore = await niceBackendFetch(`/api/latest/payments/items/custom/${customCustomerId}/custom-item`, {
    accessType: "admin",
  });
  expect(getBefore.status).toBe(200);
  expect(getBefore.body.quantity).toBe(0);

  const postChange = await niceBackendFetch(`/api/latest/payments/items/custom/${customCustomerId}/custom-item/update-quantity?allow_negative=false`, {
    method: "POST",
    accessType: "admin",
    body: { delta: 3, description: "grant" },
  });
  expect(postChange.status).toBe(200);

  const getAfter = await niceBackendFetch(`/api/latest/payments/items/custom/${customCustomerId}/custom-item`, {
    accessType: "admin",
  });
  expect(getAfter.status).toBe(200);
  expect(getAfter.body.quantity).toBe(3);
});
