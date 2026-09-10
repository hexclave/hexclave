import { randomUUID } from "node:crypto";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { expect } from "vitest";
import { it } from "../../../../../helpers";
import { Auth, Payments as PaymentsHelper, Project, Team, User, niceBackendFetch } from "../../../../backend-helpers";

type PaymentsConfigOptions = {
  extraProducts?: Record<string, any>,
  extraItems?: Record<string, any>,
};

async function setupProjectWithPaymentsConfig(options: PaymentsConfigOptions = {}) {
  await Project.createAndSwitch();
  await PaymentsHelper.setup();
  const baseProducts = {
    "sub-product": {
      displayName: "Sub Product",
      customerType: "user",
      serverOnly: false,
      stackable: false,
      prices: {
        monthly: { USD: "1000", interval: [1, "month"] },
      },
      includedItems: {},
    },
    "otp-product": {
      displayName: "One-Time Product",
      customerType: "user",
      serverOnly: false,
      stackable: false,
      prices: {
        single: { USD: "5000" },
      },
      includedItems: {},
    },
  };
  const baseItems = {
    credits: { displayName: "Credits", customerType: "user" },
  };
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        ...baseProducts,
        ...(options.extraProducts ?? {}),
      },
      items: {
        ...baseItems,
        ...(options.extraItems ?? {}),
      },
    },
  });
  return {
    products: baseProducts,
    items: baseItems,
  };
}

async function createPurchaseCodeForCustomer(options: { customerType: "user" | "team" | "custom", customerId: string, productId: string }) {
  const res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: options.customerType,
      customer_id: options.customerId,
      product_id: options.productId,
    },
  });
  expect(res.status).toBe(200);
  const codeMatch = (res.body.url as string).match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();
  return code as string;
}

const stripeWebhookSecret = getEnvVariable("STACK_STRIPE_WEBHOOK_SECRET", "mock_stripe_webhook_secret");

async function sendStripeWebhook(payload: unknown) {
  return await PaymentsHelper.sendStripeWebhook(payload, { secret: stripeWebhookSecret });
}
async function createPurchaseCode(options: { userId: string, productId: string }) {
  return await createPurchaseCodeForCustomer({
    customerType: "user",
    customerId: options.userId,
    productId: options.productId,
  });
}

it("returns empty list for fresh project", async () => {
  await Project.createAndSwitch();
  await PaymentsHelper.setup();

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "next_cursor": null,
          "transactions": [],
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
});

it("includes TEST_MODE subscription", async () => {
  await setupProjectWithPaymentsConfig();
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId: "sub-product" });

  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: code, price_id: "monthly", quantity: 1 },
  });
  expect(testModeRes.status).toBe(200);

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(response.body.transactions).toMatchInlineSnapshot(`
    [
      {
        "adjusted_by": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "customer_id": "<stripped UUID>",
        "customer_type": "user",
        "effective_at_millis": <stripped field 'effective_at_millis'>,
        "entries": [
          {
            "adjusted_entry_index": null,
            "adjusted_transaction_id": null,
            "customer_id": "<stripped UUID>",
            "customer_type": "user",
            "price_id": "monthly",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "Sub Product",
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
            "product_id": "sub-product",
            "quantity": 1,
            "subscription_id": "<stripped UUID>",
            "type": "product_grant",
          },
        ],
        "id": "<stripped UUID>",
        "renewal_target_subscription_id": null,
        "test_mode": true,
        "type": "purchase",
      },
    ]
  `);
});

it("includes TEST_MODE one-time purchase", async () => {
  await setupProjectWithPaymentsConfig();
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId: "otp-product" });

  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: code, price_id: "single", quantity: 1 },
  });
  expect(testModeRes.status).toBe(200);

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(response.body.transactions).toMatchInlineSnapshot(`
    [
      {
        "adjusted_by": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "customer_id": "<stripped UUID>",
        "customer_type": "user",
        "effective_at_millis": <stripped field 'effective_at_millis'>,
        "entries": [
          {
            "adjusted_entry_index": null,
            "adjusted_transaction_id": null,
            "customer_id": "<stripped UUID>",
            "customer_type": "user",
            "one_time_purchase_id": "<stripped UUID>",
            "price_id": "single",
            "product": {
              "client_metadata": null,
              "client_read_only_metadata": null,
              "customer_type": "user",
              "display_name": "One-Time Product",
              "included_items": {},
              "prices": { "single": { "USD": "5000" } },
              "server_metadata": null,
              "server_only": false,
              "stackable": false,
            },
            "product_id": "otp-product",
            "quantity": 1,
            "type": "product_grant",
          },
        ],
        "id": "<stripped UUID>",
        "renewal_target_subscription_id": null,
        "test_mode": true,
        "type": "purchase",
      },
    ]
  `);
});

it("includes item quantity change entries", async () => {
  await setupProjectWithPaymentsConfig();
  const { userId } = await Auth.fastSignUp();

  const changeRes = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/credits/update-quantity`, {
    accessType: "server",
    method: "POST",
    query: { allow_negative: "false" },
    body: { delta: 5, description: "test" },
  });
  expect(changeRes.status).toBe(200);

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(response.body.transactions).toMatchInlineSnapshot(`
    [
      {
        "adjusted_by": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "customer_id": "<stripped UUID>",
        "customer_type": "user",
        "effective_at_millis": <stripped field 'effective_at_millis'>,
        "entries": [
          {
            "adjusted_entry_index": null,
            "adjusted_transaction_id": null,
            "customer_id": "<stripped UUID>",
            "customer_type": "user",
            "item_id": "credits",
            "quantity": 5,
            "type": "item_quantity_change",
          },
        ],
        "id": "<stripped UUID>",
        "renewal_target_subscription_id": null,
        "test_mode": false,
        "type": "manual-item-quantity-change",
      },
    ]
  `);
});

it("supports concatenated cursor pagination", async () => {
  await setupProjectWithPaymentsConfig();
  const { userId } = await Auth.fastSignUp();

  // Make a few entries across tables
  {
    const code = await createPurchaseCode({ userId, productId: "sub-product" });
    await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
      accessType: "admin",
      method: "POST",
      body: { full_code: code, price_id: "monthly", quantity: 1 },
    });
  }
  {
    const code = await createPurchaseCode({ userId, productId: "otp-product" });
    await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
      accessType: "admin",
      method: "POST",
      body: { full_code: code, price_id: "single", quantity: 1 },
    });
  }
  await niceBackendFetch(`/api/latest/payments/items/user/${userId}/credits/update-quantity`, {
    accessType: "server",
    method: "POST",
    query: { allow_negative: "false" },
    body: { delta: 2 },
  });

  const page1 = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { limit: "2" },
  });
  expect(page1.status).toBe(200);
  expect(page1.body).toMatchObject({ next_cursor: expect.any(String) });

  const page2 = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { limit: "2", cursor: page1.body.next_cursor },
  });
  expect(page2.status).toBe(200);
  expect(page2.body).toMatchObject({ transactions: expect.any(Array) });
});

it("omits subscription-renewal entries for subscription creation invoices", async () => {
  const config = await setupProjectWithPaymentsConfig();
  const subProduct = config.products["sub-product"];
  const { userId } = await Auth.fastSignUp();

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const code = await createPurchaseCode({ userId, productId: "sub-product" });
  const tenancyId = code.split("_")[0];

  const idSuffix = randomUUID().replace(/-/g, "");
  const nowSec = Math.floor(Date.now() / 1000);
  const stripeSubscription = {
    id: `sub_tx_filter_${idSuffix}`,
    status: "active",
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: nowSec - 60,
          current_period_end: nowSec + 60 * 60,
        },
      ],
    },
    metadata: {
      productId: "sub-product",
      product: JSON.stringify(subProduct),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const stackStripeMockData = {
    "accounts.retrieve": { metadata: { tenancyId } },
    "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
    "subscriptions.list": { data: [stripeSubscription] },
  };

  const baseInvoiceObject = {
    customer: `cus_tx_filter_${idSuffix}`,
    stack_stripe_mock_data: stackStripeMockData,
    lines: {
      data: [
        {
          parent: {
            subscription_item_details: {
              subscription: stripeSubscription.id,
            },
          },
        },
      ],
    },
  };

  const creationInvoiceEvent = {
    id: `evt_sub_invoice_creation_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        id: `in_creation_tx_${idSuffix}`,
        billing_reason: "subscription_create",
      },
    },
  };

  const renewalInvoiceEvent = {
    id: `evt_sub_invoice_cycle_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        id: `in_cycle_tx_${idSuffix}`,
        billing_reason: "subscription_cycle",
      },
    },
  };

  const creationRes = await sendStripeWebhook(creationInvoiceEvent);
  expect(creationRes.status).toBe(200);
  expect(creationRes.body).toEqual({ received: true });

  const renewalRes = await sendStripeWebhook(renewalInvoiceEvent);
  expect(renewalRes.status).toBe(200);
  expect(renewalRes.body).toEqual({ received: true });

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);

  const renewalTransactions = response.body.transactions.filter((tx: any) => tx.type === "subscription-renewal");
  expect(renewalTransactions.length).toBe(1);
  expect(renewalTransactions[0]?.entries?.[0]?.type).toBe("money_transfer");

  const purchaseTransaction = response.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTransaction).toBeDefined();
});

it("books subscription-renewal money when a free trial converts via subscription_cycle invoice", async () => {
  // Mirrors Stripe: trial create → billing_reason=subscription_create ($0, filtered);
  // trial end charge → billing_reason=subscription_cycle (booked as subscription-renewal).
  const trialProduct = {
    displayName: "Trial Product",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: {
      monthly: { USD: "19.00", interval: [1, "month"], freeTrial: [14, "day"] },
    },
    includedItems: {},
  };
  await setupProjectWithPaymentsConfig({
    extraProducts: { "trial-product": trialProduct },
  });
  // Keep testMode from setupProjectWithPaymentsConfig (true). create-purchase-url
  // only needs a tenancy id here; the Stripe-synced subscription is still
  // creationSource=PURCHASE_PAGE → paymentProvider=stripe, so trial start money
  // gating and renewal invoicing behave the same.
  const { userId } = await Auth.fastSignUp();

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const code = await createPurchaseCodeForCustomer({
    customerType: "user",
    customerId: userId,
    productId: "trial-product",
  });
  const tenancyId = code.split("_")[0];

  const idSuffix = randomUUID().replace(/-/g, "");
  const nowSec = Math.floor(Date.now() / 1000);
  const stripeSubscription = {
    id: `sub_tx_trial_${idSuffix}`,
    status: "trialing",
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: nowSec - 60,
          current_period_end: nowSec + 14 * 24 * 60 * 60,
        },
      ],
    },
    metadata: {
      productId: "trial-product",
      product: JSON.stringify(trialProduct),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const stackStripeMockData = {
    "accounts.retrieve": { metadata: { tenancyId } },
    "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
    "subscriptions.list": { data: [stripeSubscription] },
  };

  const baseInvoiceObject = {
    customer: `cus_tx_trial_${idSuffix}`,
    currency: "usd",
    stack_stripe_mock_data: stackStripeMockData,
    lines: {
      data: [
        {
          description: "Trial Product",
          quantity: 1,
          parent: {
            subscription_item_details: {
              subscription: stripeSubscription.id,
            },
          },
        },
      ],
    },
  };

  const creationRes = await sendStripeWebhook({
    id: `evt_trial_create_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        id: `in_trial_create_${idSuffix}`,
        billing_reason: "subscription_create",
        total: 0,
        amount_paid: 0,
      },
    },
  });
  expect(creationRes.status).toBe(200);

  let response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(response.body.transactions.filter((tx: any) => tx.type === "subscription-renewal")).toHaveLength(0);

  const purchaseTxn = response.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTxn).toBeDefined();
  expect(purchaseTxn.entries.some((entry: any) => entry.type === "money_transfer")).toBe(false);

  // After trial: Stripe charges and emits a cycle invoice (not subscription_create).
  const activeSubscription = { ...stripeSubscription, status: "active" };
  const cycleMockData = {
    ...stackStripeMockData,
    "subscriptions.list": { data: [activeSubscription] },
  };
  const cycleRes = await sendStripeWebhook({
    id: `evt_trial_cycle_${idSuffix}`,
    type: "invoice.payment_succeeded",
    created: Math.floor(Date.now() / 1000),
    account: accountId,
    data: {
      object: {
        ...baseInvoiceObject,
        stack_stripe_mock_data: cycleMockData,
        id: `in_trial_cycle_${idSuffix}`,
        billing_reason: "subscription_cycle",
        total: 1900,
        amount_paid: 1900,
      },
    },
  });
  expect(cycleRes.status).toBe(200);

  response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);

  const renewalTransactions = response.body.transactions.filter((tx: any) => tx.type === "subscription-renewal");
  expect(renewalTransactions).toHaveLength(1);
  expect(renewalTransactions[0]?.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "money_transfer",
      charged_amount: expect.objectContaining({ USD: "19.00" }),
    }),
  ]));
});

it("filters results by transaction type", async () => {
  await setupProjectWithPaymentsConfig();
  const { userId } = await Auth.fastSignUp();

  const subCode = await createPurchaseCode({ userId, productId: "sub-product" });
  await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: subCode, price_id: "monthly", quantity: 1 },
  });

  await niceBackendFetch(`/api/latest/payments/items/user/${userId}/credits/update-quantity`, {
    accessType: "server",
    method: "POST",
    query: { allow_negative: "false" },
    body: { delta: 3 },
  });

  const manualOnly = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { type: "manual-item-quantity-change" },
  });
  expect(manualOnly.status).toBe(200);
  expect(manualOnly.body.transactions).toHaveLength(1);
  expect(manualOnly.body.transactions[0].type).toBe("manual-item-quantity-change");

  const purchaseOnly = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { type: "purchase" },
  });
  expect(purchaseOnly.status).toBe(200);
  expect(purchaseOnly.body.transactions).toHaveLength(1);
  expect(purchaseOnly.body.transactions[0].type).toBe("purchase");
});

it("filters results by customer_type across sources", async () => {
  await setupProjectWithPaymentsConfig({
    extraProducts: {
      "team-product": {
        displayName: "Team Product",
        customerType: "team",
        serverOnly: false,
        stackable: false,
        prices: {
          team_monthly: { USD: "2500", interval: [1, "month"] },
        },
        includedItems: {},
      },
    },
    extraItems: {
      "team-credits": { displayName: "Team Credits", customerType: "team" },
    },
  });
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.create({ accessType: "server", creatorUserId: userId });

  const userCode = await createPurchaseCode({ userId, productId: "sub-product" });
  await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: userCode, price_id: "monthly", quantity: 1 },
  });

  const teamCode = await createPurchaseCodeForCustomer({
    customerType: "team",
    customerId: teamId,
    productId: "team-product",
  });
  await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: teamCode, price_id: "team_monthly", quantity: 1 },
  });

  await niceBackendFetch(`/api/latest/payments/items/team/${teamId}/team-credits/update-quantity`, {
    accessType: "server",
    method: "POST",
    query: { allow_negative: "false" },
    body: { delta: 4 },
  });

  const teamResponse = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { customer_type: "team" },
  });
  expect(teamResponse.status).toBe(200);
  expect(teamResponse.body.transactions).toHaveLength(2);
  expect(teamResponse.body.transactions.every((tx: any) =>
    tx.entries.every((entry: any) => entry.customer_type === "team")
  )).toBe(true);

  const userResponse = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
    query: { customer_type: "user" },
  });
  expect(userResponse.status).toBe(200);
  expect(userResponse.body.transactions).toHaveLength(1);
  expect(userResponse.body.transactions[0].entries.every((entry: any) => entry.customer_type === "user")).toBe(true);
});

it("returns server-granted subscriptions in transactions", async () => {
  await setupProjectWithPaymentsConfig({
    extraProducts: {
      "subscription-a": {
        displayName: "Subscription A",
        customerType: "user",
        serverOnly: false,
        stackable: true,
        prices: {
          monthly: { USD: "12.34",  interval: [1, "month"] },
        },
        includedItems: {},
      },
    },
  });
  const { userId } = await Auth.fastSignUp();

  const grantResponse = await niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    accessType: "server",
    method: "POST",
    body: { product_id: "subscription-a", quantity: 3 },
  });
  expect(grantResponse.status).toBe(200);

  const response = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchInlineSnapshot(`
    {
      "next_cursor": null,
      "transactions": [
        {
          "adjusted_by": [],
          "created_at_millis": <stripped field 'created_at_millis'>,
          "customer_id": "<stripped UUID>",
          "customer_type": "user",
          "effective_at_millis": <stripped field 'effective_at_millis'>,
          "entries": [
            {
              "adjusted_entry_index": null,
              "adjusted_transaction_id": null,
              "customer_id": "<stripped UUID>",
              "customer_type": "user",
              "price_id": null,
              "product": {
                "client_metadata": null,
                "client_read_only_metadata": null,
                "customer_type": "user",
                "display_name": "Subscription A",
                "included_items": {},
                "prices": {
                  "monthly": {
                    "USD": "12.34",
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
              "product_id": "subscription-a",
              "quantity": 3,
              "subscription_id": "<stripped UUID>",
              "type": "product_grant",
            },
          ],
          "id": "<stripped UUID>",
          "renewal_target_subscription_id": null,
          "test_mode": false,
          "type": "purchase",
        },
      ],
    }
  `);

});
