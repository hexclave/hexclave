import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { Auth, Payments, Project, niceBackendFetch } from "../backend-helpers";

export function createDefaultPaymentsConfig(testMode: boolean | undefined) {
  return {
    payments: {
      testMode: testMode ?? true,
      products: {
        "otp-product": {
          displayName: "One-Time Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            single: { USD: "50.00" },
          },
          includedItems: {},
        },
      },
      items: {},
    },
  };
}

export async function setupProjectWithPaymentsConfig(options: { testMode?: boolean } = {}) {
  await Project.createAndSwitch();
  await Payments.setup();
  const config = createDefaultPaymentsConfig(options.testMode);
  await Project.updateConfig({
    ...config,
    "apps.installed.payments.enabled": true,
  });
  return config;
}

export async function createPurchaseCode(options: { userId: string, productId: string }) {
  const res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: options.userId,
      product_id: options.productId,
    },
  });
  expect(res.status).toBe(200);
  const codeMatch = (res.body.url as string).match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();
  return code as string;
}

export async function createTestModeTransaction(productId: string, priceId: string) {
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId });
  const response = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    accessType: "admin",
    method: "POST",
    body: { full_code: code, price_id: priceId, quantity: 1 },
  });
  expect(response.status).toBe(200);
  const transactions = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(transactions.status).toBe(200);
  expect(transactions.body.transactions.length).toBeGreaterThan(0);
  const transaction = transactions.body.transactions[0];
  return { transactionId: transaction.id, userId };
}

export async function createLiveModeOneTimePurchaseTransaction(options: { quantity?: number } = {}) {
  const config = await setupProjectWithPaymentsConfig({ testMode: false });
  const { userId } = await Auth.fastSignUp();
  const quantity = options.quantity ?? 1;

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const code = await createPurchaseCode({ userId, productId: "otp-product" });
  const stackTestTenancyId = code.split("_")[0];
  const product = config.payments.products["otp-product"];

  const idSuffix = randomUUID().replace(/-/g, "");
  const eventId = `evt_otp_purchase_${idSuffix}`;
  const paymentIntentId = `pi_otp_purchase_${idSuffix}`;
  const paymentIntentPayload = {
    id: eventId,
    type: "payment_intent.succeeded",
    created: Math.floor(new Date().getTime() / 1000),
    account: accountId,
    data: {
      object: {
        id: paymentIntentId,
        customer: userId,
        amount_received: 5_000 * quantity,
        currency: "usd",
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
        metadata: {
          productId: "otp-product",
          product: JSON.stringify(product),
          customerId: userId,
          customerType: "user",
          purchaseQuantity: String(quantity),
          purchaseKind: "ONE_TIME",
          priceId: "single",
        },
      },
    },
  };

  const webhookSecret = getEnvVariable("STACK_STRIPE_WEBHOOK_SECRET", "mock_stripe_webhook_secret");
  const webhookRes = await Payments.sendStripeWebhook(paymentIntentPayload, { secret: webhookSecret });
  expect(webhookRes.status).toBe(200);
  expect(webhookRes.body).toEqual({ received: true });

  const transactionsRes = await niceBackendFetch("/api/latest/internal/payments/transactions", {
    accessType: "admin",
  });
  expect(transactionsRes.status).toBe(200);

  const purchaseTransaction = transactionsRes.body.transactions.find((tx: any) => tx.type === "purchase");
  expect(purchaseTransaction).toBeDefined();

  return { userId, transactionsRes, purchaseTransaction };
}
