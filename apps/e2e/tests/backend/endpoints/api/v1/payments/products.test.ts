import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { it } from "../../../../../helpers";
import { Auth, niceBackendFetch, Payments, Project, Team } from "../../../../backend-helpers";

async function configureProduct(config: any) {
  await Project.updateConfig({
    payments: config,
  });
}

it("should reject client requests to grant product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "client",
    body: {
      product_id: "pro-plan",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "client",
          "allowed_access_types": [
            "server",
            "admin",
          ],
        },
        "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should grant configured subscription product and expose it via listing", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const grantResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-plan",
    },
  });

  expect(grantResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "subscription_id": "<stripped UUID>",
        "success": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "pro-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Pro Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1000",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow a signed-in user to cancel their own subscription product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-plan",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "pro-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Pro Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1000",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": true,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": false,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should report a canceled-at-period-end subscription as still in effect, and reject a second cancel", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-plan",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse.status).toBe(200);

  // Must not masquerade as a one-time purchase during the paid-through window
  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(listResponse.status).toBe(200);
  const item = (listResponse.body as { items: Array<{ id: string, type: string, subscription: { cancel_at_period_end: boolean, is_cancelable: boolean } | null }> }).items.find((i) => i.id === "pro-plan");
  expect(item?.type).toBe("subscription");
  expect(item?.subscription?.cancel_at_period_end).toBe(true);
  expect(item?.subscription?.is_cancelable).toBe(false);

  const secondCancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(secondCancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This subscription is already canceled and ends at the end of the current billing period.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should keep the active sub's cancel button when one quantity of a stackable product is canceled", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "seats-plan": {
        displayName: "Seats Plan",
        customerType: "user",
        serverOnly: false,
        stackable: true,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const firstGrant = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "seats-plan" },
  });
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "seats-plan" },
  });

  // Cancel only the first quantity by subscription id — the second sub stays active
  const firstSubscriptionId = (firstGrant.body as { subscription_id: string }).subscription_id;
  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/seats-plan?subscription_id=${encodeURIComponent(firstSubscriptionId)}`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse.status).toBe(200);

  // The winding-down sub must not shadow the active one: the product stays cancelable
  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  const item = (listResponse.body as { items: Array<{ id: string, type: string, quantity: number, subscription: { subscription_id: string, cancel_at_period_end: boolean, is_cancelable: boolean } | null }> }).items.find((i) => i.id === "seats-plan");
  expect(item?.type).toBe("subscription");
  expect(item?.subscription?.cancel_at_period_end).toBe(false);
  expect(item?.subscription?.is_cancelable).toBe(true);
  expect(item?.subscription?.subscription_id).not.toBe(firstSubscriptionId);

  // Double-canceling the already-canceled quantity returns the dedicated error
  const secondCancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/seats-plan?subscription_id=${encodeURIComponent(firstSubscriptionId)}`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(secondCancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This subscription is already canceled and ends at the end of the current billing period.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow granting another plan in the same product line while the old one winds down", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    productLines: {
      plans: { displayName: "Plans", customerType: "user" },
    },
    products: {
      "plan-a": {
        displayName: "Plan A",
        customerType: "user",
        productLineId: "plans",
        serverOnly: false,
        stackable: false,
        prices: { monthly: { USD: "1000", interval: [1, "month"] } },
        includedItems: {},
      },
      "plan-b": {
        displayName: "Plan B",
        customerType: "user",
        productLineId: "plans",
        serverOnly: false,
        stackable: false,
        prices: { monthly: { USD: "2000", interval: [1, "month"] } },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "plan-a" },
  });
  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/plan-a`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse.status).toBe(200);

  // The winding-down plan-a sub must count as a replaceable conflict, not as
  // a one-time purchase blocking the line
  const grantBResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "plan-b" },
  });
  expect(grantBResponse.status).toBe(200);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  const items = (listResponse.body as { items: Array<{ id: string, type: string }> }).items;
  expect(items.find((i) => i.id === "plan-b")?.type).toBe("subscription");
});

it("should reject a client canceling someone else's subscription product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId: userId1 } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId1}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-plan",
    },
  });

  const { userId: userId2 } = await Auth.fastSignUp();
  expect(userId2).not.toEqual(userId1);

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId1}/pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "Clients can only cancel their own subscriptions.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow a server to cancel someone else's subscription product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "pro-plan": {
        displayName: "Pro Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-plan",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/pro-plan`, {
    method: "DELETE",
    accessType: "server",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should cancel all stackable subscription quantities", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "seats-plan": {
        displayName: "Seats Plan",
        customerType: "user",
        serverOnly: false,
        stackable: true,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "seats-plan",
    },
  });
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "seats-plan",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/seats-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "seats-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Seats Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1000",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": true,
            },
            "quantity": 2,
            "subscription": {
              "cancel_at_period_end": true,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": false,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("stackable add-on in the same product line accumulates across grants instead of being replaced", async ({ expect }) => {
  // Regression test: before the fix, granting a stackable add-on twice while
  // the customer already owned a base plan in the same product line caused
  // the second grant to treat the first as a "conflict in the plans line",
  // canceling the first sub and replacing its quantity instead of adding
  // another sub alongside. The bug only surfaced when the stackable product
  // had a `productLineId` AND another product in that line was owned —
  // stackable products without a productLineId, or without siblings in the
  // line, already accumulated correctly (see the sibling test above).
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    productLines: {
      plans: { displayName: "Plans", customerType: "team" },
    },
    products: {
      "base-plan": {
        displayName: "Base Plan",
        customerType: "team",
        productLineId: "plans",
        serverOnly: false,
        stackable: false,
        prices: { monthly: { USD: "1000", interval: [1, "month"] } },
        includedItems: {},
      },
      "extra-seats": {
        displayName: "Extra Seats",
        customerType: "team",
        productLineId: "plans",
        serverOnly: false,
        stackable: true,
        isAddOnTo: { "base-plan": true },
        prices: { monthly: { USD: "100", interval: [1, "month"] } },
        includedItems: {},
      },
    },
  });

  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator({ accessType: "server" });

  // Base plan first so the add-on's isAddOnTo prerequisite is satisfied.
  const baseResponse = await niceBackendFetch(`/api/v1/payments/products/team/${teamId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "base-plan" },
  });
  expect(baseResponse.status).toBe(200);

  const firstAddOnResponse = await niceBackendFetch(`/api/v1/payments/products/team/${teamId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "extra-seats", quantity: 1 },
  });
  expect(firstAddOnResponse.status).toBe(200);

  const secondAddOnResponse = await niceBackendFetch(`/api/v1/payments/products/team/${teamId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "extra-seats", quantity: 2 },
  });
  expect(secondAddOnResponse.status).toBe(200);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/team/${teamId}`, {
    accessType: "server",
  });
  expect(listResponse.status).toBe(200);
  const items = (listResponse.body as { items: Array<{ id: string, quantity: number }> }).items;
  const extraSeats = items.find((i) => i.id === "extra-seats");
  const basePlan = items.find((i) => i.id === "base-plan");
  // Base plan untouched by the add-on grants.
  expect(basePlan?.quantity).toBe(1);
  // Add-on quantities accumulate: 1 (first grant) + 2 (second grant) = 3.
  // Before the fix this came out as 2 (the second grant's quantity, because
  // the first sub was canceled as a "conflict" and replaced).
  expect(extraSeats?.quantity).toBe(3);
});

it("should reject canceling a one-time purchase product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "one-time": {
        displayName: "One Time",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          once: {
            USD: "1000",
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "one-time",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/one-time`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This product is a one time purchase and cannot be canceled.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow a team admin to cancel a team's subscription product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "team-pro-plan": {
        displayName: "Team Pro Plan",
        customerType: "team",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.create({ accessType: "server", creatorUserId: userId });

  await niceBackendFetch(`/api/v1/payments/products/team/${teamId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "team-pro-plan",
    },
  });

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/team/${teamId}/team-pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should hide server-only products from clients while exposing them to servers", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "server-plan": {
        displayName: "Server Plan",
        customerType: "user",
        serverOnly: true,
        stackable: false,
        prices: {
          monthly: {
            USD: "1500",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const grantResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "server-plan",
    },
  });

  expect(grantResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "subscription_id": "<stripped UUID>",
        "success": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const clientListResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });

  expect(clientListResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const serverListResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "server",
  });

  expect(serverListResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "server-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Server Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1500",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": true,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should prevent granting an already owned non-stackable product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "single-plan": {
        displayName: "Single Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const firstGrant = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "single-plan",
    },
  });
  expect(firstGrant.status).toBe(200);

  const secondGrant = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "single-plan",
    },
  });

  expect(secondGrant).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_ALREADY_GRANTED",
        "details": {
          "customer_id": "<stripped UUID>",
          "product_id": "single-plan",
        },
        "error": "Customer with ID \\"<stripped UUID>\\" already owns product \\"single-plan\\".",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_ALREADY_GRANTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should allow granting stackable product with custom quantity", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "stackable-plan": {
        displayName: "Stackable Plan",
        customerType: "user",
        serverOnly: false,
        stackable: true,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const grantResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "stackable-plan",
      quantity: 3,
    },
  });
  expect(grantResponse.status).toBe(200);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "stackable-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Stackable Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1000",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": true,
            },
            "quantity": 3,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should grant inline product without needing configuration", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  const { userId } = await Auth.fastSignUp();

  const grantResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_inline: {
        display_name: "Inline Access",
        customer_type: "user",
        server_only: true,
        prices: {
          quarterly: {
            USD: "2400",
            interval: [3, "month"],
          },
        },
        included_items: {},
        server_metadata: {
          cohort: "beta",
          flags: ["inline-grant"],
        },
      },
    },
  });
  expect(grantResponse.status).toBe(200);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "server",
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": null,
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Inline Access",
              "included_items": {},
              "prices": {
                "quarterly": {
                  "USD": "2400",
                  "interval": [
                    3,
                    "month",
                  ],
                },
              },
              "server_metadata": {
                "cohort": "beta",
                "flags": ["inline-grant"],
              },
              "server_only": true,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow canceling an inline product subscription via subscription_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  const grantResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_inline: {
        display_name: "Inline Sub",
        customer_type: "user",
        server_only: false,
        prices: {
          monthly: {
            USD: "500",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(grantResponse.status).toBe(200);

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(listResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": null,
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Inline Sub",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "500",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  // The grant response returns the subscription_id for inline products
  const subscriptionId = grantResponse.body.subscription_id;
  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/_inline?subscription_id=${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(cancelResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const afterCancelList = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(afterCancelList).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": null,
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Inline Sub",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "500",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": true,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": false,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject requests missing product details", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
    },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Must specify either product_id or product_inline!",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject quantity > 1 for non-stackable product", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "limited-plan": {
        displayName: "Limited Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "limited-plan",
      quantity: 2,
    },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This product is not stackable; quantity must be 1",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject product/customer type mismatch", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "team-plan": {
        displayName: "Team Plan",
        customerType: "team",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "team-plan",
    },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        "details": {
          "actual_customer_type": "user",
          "customer_id": "<stripped UUID>",
          "product_customer_type": "team",
          "product_id": "team-plan",
        },
        "error": "The user with ID \\"<stripped UUID>\\" is not a valid customer for the inline product that has been passed in. The product is configured to only be available for team customers, but the customer is a user.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should return user not found when granting to missing user", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    products: {
      "solo-plan": {
        displayName: "Solo Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {},
      },
    },
  });

  const response = await niceBackendFetch(`/api/v1/payments/products/user/${generateUuid()}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "solo-plan",
    },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "USER_NOT_FOUND",
        "error": "User not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});


it("listing owned products should require authentication", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`);
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

it("listing products should return empty list when customer owns no products", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });

  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "is_paginated": true,
          "items": [],
          "pagination": { "next_cursor": null },
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
});

it("listing products should list both subscription and one-time products", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "subscription-plan": {
          displayName: "Subscription Plan",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: {
              USD: "1200",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
        "lifetime-addon": {
          displayName: "Lifetime Add-on",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            lifetime: {
              USD: "5000",
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  const grantSubscription = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "subscription-plan",
    },
  });
  expect(grantSubscription.status).toBe(200);

  const grantOneTime = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "lifetime-addon",
    },
  });
  expect(grantOneTime.status).toBe(200);

  const response = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "lifetime-addon",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Lifetime Add-on",
              "included_items": {},
              "prices": { "lifetime": { "USD": "5000" } },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": null,
            "type": "one_time",
          },
          {
            "id": "subscription-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Subscription Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1200",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("listing products should support cursor pagination", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "subscription-plan": {
          displayName: "Subscription Plan",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: {
              USD: "1200",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
        "lifetime-addon": {
          displayName: "Lifetime Add-on",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            lifetime: {
              USD: "5000",
            },
          },
          includedItems: {},
        },
        "pro-addon": {
          displayName: "Pro Add-on",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            standard: {
              USD: "7000",
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();

  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "subscription-plan",
    },
  });

  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "lifetime-addon",
    },
  });

  await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "pro-addon",
    },
  });

  const basePath = `/api/v1/payments/products/user/${userId}`;
  const allResponse = await niceBackendFetch(basePath, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });


  const firstPage = await niceBackendFetch(`${basePath}?limit=1`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(firstPage).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "lifetime-addon",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Lifetime Add-on",
              "included_items": {},
              "prices": { "lifetime": { "USD": "5000" } },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": null,
            "type": "one_time",
          },
        ],
        "pagination": { "next_cursor": "pro-addon" },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const cursor = firstPage.body.pagination.next_cursor;
  const secondPage = await niceBackendFetch(`${basePath}?limit=5&cursor=${encodeURIComponent(cursor)}`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(secondPage).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "id": "pro-addon",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Pro Add-on",
              "included_items": {},
              "prices": { "standard": { "USD": "7000" } },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": null,
            "type": "one_time",
          },
          {
            "id": "subscription-plan",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Subscription Plan",
              "included_items": {},
              "prices": {
                "monthly": {
                  "USD": "1200",
                  "interval": [
                    1,
                    "month",
                  ],
                },
              },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "quantity": 1,
            "subscription": {
              "cancel_at_period_end": false,
              "current_period_end": <stripped field 'current_period_end'>,
              "is_cancelable": true,
              "subscription_id": "<stripped UUID>",
            },
            "type": "subscription",
          },
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const combinedItems = [...firstPage.body.items, ...secondPage.body.items];
  expect(combinedItems).toEqual(allResponse.body.items);
});

it("should cancel existing subscriptions immediately when granting a product of same catalog", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await configureProduct({
    testMode: true,
    items: {
      i1: {
        displayName: "Item 1",
      },
    },
    productLines: {
      grp: {
        displayName: "Product Line",
      },
    },
    products: {
      base: {
        displayName: "Base Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        productLineId: "grp",
        prices: {
          monthly: {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        includedItems: {
          i1: {
            quantity: 2,
            repeat: "never",
            expires: "when-purchase-expires",
          },
        },
      },
      premium: {
        displayName: "Premium Plan",
        customerType: "user",
        serverOnly: false,
        stackable: false,
        productLineId: "grp",
        prices: {
          monthly: {
            USD: "2000",
            interval: [1, "month"],
          },
        },
        includedItems: {
          i1: {
            quantity: 3,
            repeat: "never",
            expires: "when-purchase-expires",
          },
        },
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const grantBaseResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "base" },
  });
  expect(grantBaseResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "subscription_id": "<stripped UUID>",
        "success": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const grantPremiumResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "premium" },
  });
  expect(grantPremiumResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "subscription_id": "<stripped UUID>",
        "success": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // wait for timefold to process and catch up with lastProcessedAt; this usually takes <1 second
  await wait(2000);

  const itemQuantities = await niceBackendFetch(`/api/v1/payments/items/user/${userId}/i1`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(itemQuantities).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "display_name": "Item 1",
        "id": "i1",
        "quantity": 3,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("refreshes the local billing period from Stripe's response when canceling at period end", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();

  const product = {
    displayName: "Pro Plan",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: {
      monthly: {
        USD: "1000",
        interval: [1, "month"],
      },
    },
    includedItems: {},
  };
  await configureProduct({
    testMode: false,
    products: { "pro-plan": product },
  });

  const { userId } = await Auth.fastSignUp();

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrl = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "pro-plan" },
  });
  expect(createUrl.status).toBe(200);
  const fullCode = (createUrl.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(fullCode).toBeDefined();
  const tenancyId = (fullCode as string).split("_")[0];

  // Seed the local row with a period that ends in an hour. stripe-mock reports a
  // different period on the cancel response, which stands in for a local row
  // that drifted from Stripe (e.g. a renewal we never synced).
  const nowSec = Math.floor(Date.now() / 1000);
  const idSuffix = generateUuid().replace(/-/g, "");
  const stripeSubscription = {
    id: `sub_cancel_period_${idSuffix}`,
    status: "active",
    items: {
      data: [{
        quantity: 1,
        current_period_start: nowSec - 60,
        current_period_end: nowSec + 60 * 60,
      }],
    },
    metadata: {
      productId: "pro-plan",
      product: JSON.stringify(product),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const startWebhook = await Payments.sendStripeWebhook({
    id: `evt_cancel_period_${idSuffix}`,
    type: "invoice.payment_succeeded",
    account: accountId,
    data: {
      object: {
        id: `in_cancel_period_${idSuffix}`,
        customer: `cus_cancel_period_${idSuffix}`,
        billing_reason: "subscription_create",
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [stripeSubscription] },
        },
        lines: {
          data: [{
            parent: { subscription_item_details: { subscription: stripeSubscription.id } },
          }],
        },
      },
    },
  });
  expect(startWebhook.status).toBe(200);

  const readSubscription = async () => {
    for (let i = 0; i < 30; i++) {
      const res = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
        accessType: "client",
      });
      expect(res.status).toBe(200);
      const items = (res.body as {
        items: Array<{
          id: string,
          subscription: { cancel_at_period_end: boolean, current_period_end: string | null } | null,
        }>,
      }).items;
      const sub = items.find((i) => i.id === "pro-plan")?.subscription;
      if (sub) {
        return sub;
      }
      await wait(500);
    }
    throw new Error("Subscription for pro-plan never became visible");
  };

  const beforeCancel = await readSubscription();
  const staleEndMillis = new Date(beforeCancel.current_period_end ?? throwErr("no period end")).getTime();
  expect(staleEndMillis).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000);

  const cancelResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}/pro-plan`, {
    method: "DELETE",
    accessType: "client",
  });
  expect(cancelResponse.status).toBe(200);

  // The sub must still be in effect, and "Ends on" (current_period_end) must
  // track the boundary Stripe reported rather than the stale local period —
  // otherwise entitlements and the displayed end date disagree.
  const afterCancel = await readSubscription();
  expect(afterCancel.cancel_at_period_end).toBe(true);
  const refreshedEndMillis = new Date(afterCancel.current_period_end ?? throwErr("no period end")).getTime();
  expect(refreshedEndMillis).toBeGreaterThan(staleEndMillis);
  expect(refreshedEndMillis).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
}, { timeout: 60_000 });
