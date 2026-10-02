import { randomUUID } from "node:crypto";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, bumpEmailAddress, niceBackendFetch, Payments, Project, Team } from "../../../backend-helpers";
import { getOutboxEmails } from "./emails/email-helpers";

// Stripe webhook events are now deduplicated globally by their `event.id` (see
// the StripeWebhookEvent table). The dev DB is NOT reset between test runs, so
// every claimed event needs a per-run unique id, otherwise a second run would
// hit the dedupe path and skip processing.
function uniqueEventId(prefix: string) {
  return `evt_${prefix}_${randomUUID()}`;
}

// Webhook processing now happens in the background after a fast 200 ack, so DB
// state is eventually-consistent from the test's perspective. Poll instead of
// reading immediately after the webhook returns.
async function waitForItemQuantity(
  args: { customerType: "user" | "team", customerId: string, itemId: string, expected: number },
) {
  let last: number | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await niceBackendFetch(
      `/api/latest/payments/items/${args.customerType}/${args.customerId}/${args.itemId}`,
      { accessType: "client" },
    );
    if (res.status !== 200) {
      throw new Error(`Unexpected ${res.status} reading item ${args.itemId}`);
    }
    last = res.body.quantity;
    if (last === args.expected) {
      return;
    }
    await wait(500);
  }
  throw new Error(`Item ${args.itemId} quantity never reached ${args.expected} (last seen: ${last})`);
}

async function waitForOutboxEmail(subject: string) {
  for (let i = 0; i < 30; i++) {
    const emails = await getOutboxEmails({ subject });
    if (emails.length > 0) {
      return emails[0];
    }
    await wait(500);
  }
  throw new Error(`Email with subject "${subject}" not found in outbox`);
}

async function waitForNoOutboxEmail(subject: string) {
  for (let i = 0; i < 6; i++) {
    const emails = await getOutboxEmails({ subject });
    if (emails.length > 0) {
      throw new Error(`Unexpected email with subject "${subject}" found in outbox`);
    }
    await wait(500);
  }
}


it("acks unknown signed webhook types (errors handled in background)", async ({ expect }) => {
  // We now persist + ack the event synchronously and process it in the
  // background, so an unknown type no longer surfaces a 500 to Stripe. The
  // "Unknown stripe webhook type" error is captured async and the event row is
  // marked FAILED (covered deterministically in stripe-webhook-events.test.ts).
  const payload = {
    id: uniqueEventId("mock_event_succeeded"),
    type: "mock_event.succeeded",
    account: "acct_test123",
    data: { object: { customer: "cus_test123", metadata: {} } },
  };
  const res = await Payments.sendStripeWebhook(payload);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });
});

it("returns 400 on invalid signature", async ({ expect }) => {
  const payload = {
    id: "evt_test_bad_sig",
    type: "invoice.paid",
    account: "acct_test123",
    data: { object: { customer: "cus_test456" } },
  };
  const res = await Payments.sendStripeWebhook(payload, { invalidSignature: true });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid stripe-signature header",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("acks unknown webhook types with 200 (errors handled in background)", async ({ expect }) => {
  const payload = {
    id: uniqueEventId("unknown_event"),
    type: "unknown.event",
    account: "acct_test123",
    data: { object: {} },
  };

  const res = await Payments.sendStripeWebhook(payload);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });
});

it("returns 400 when signature header is missing (schema validation)", async ({ expect }) => {
  const payload = {
    id: "evt_test_no_sig",
    type: "payment_intent.succeeded",
    account: "acct_test123",
    data: { object: { customer: "cus_test123", metadata: {} } },
  };
  const res = await Payments.sendStripeWebhook(payload, { omitSignature: true });
  expect(res.status).toBe(400);
});

it("accepts chargeback webhooks", async ({ expect }) => {
  const { code } = await Payments.createPurchaseUrlAndGetCode();
  const stackTestTenancyId = (code ?? throwErr("Missing purchase code for chargeback test.")).split("_")[0];

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const payload = {
    id: uniqueEventId("chargeback"),
    type: "charge.dispute.created",
    account: accountId,
    data: {
      object: {
        id: "dp_test_123",
        amount: 1500,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        charge: "ch_test_123",
        created: 1730000000,
        livemode: false,
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payload);
  expect(res.status).toBe(200);
  expect(res.body).toMatchInlineSnapshot(`{ "received": true }`);
});


it("deduplicates one-time purchase on payment_intent.succeeded retry", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();

  // Configure an product that grants 1 unit of an item via one-time purchase
  const itemId = "one-time-credits";
  const productId = "ot";
  const product = {
    displayName: "One-time Credits Pack",
    customerType: "user",
    serverOnly: false,
    stackable: true,
    prices: { one: { USD: "500" } },
    includedItems: { [itemId]: { quantity: 1 } },
  };

  await Project.updateConfig({
    payments: {
      items: {
        [itemId]: { displayName: "Credits", customerType: "user" },
      },
      products: {
        [productId]: product,
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  // Before webhook: quantity should be 0
  const getBefore = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/${itemId}`, {
    accessType: "client",
  });
  expect(getBefore.status).toBe(200);
  expect(getBefore.body.quantity).toBe(0);

  // Get Stripe account id for current project (created by Payments.setup)
  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  // Prepare a payment_intent.succeeded webhook payload with ONE_TIME metadata
  const paymentIntentId = "pi_test_same";
  // Derive current tenancy id from purchase URL full_code (tenancyId_code)
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];
  const payloadObj = {
    id: uniqueEventId("retry"),
    type: "payment_intent.succeeded",
    created: Math.floor(new Date().getTime() / 1000),
    account: accountId,
    data: {
      object: {
        id: paymentIntentId,
        customer: userId,
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
        metadata: {
          productId,
          product: JSON.stringify(product),
          customerId: userId,
          customerType: "user",
          purchaseQuantity: "1",
          purchaseKind: "ONE_TIME",
          priceId: "one",
        },
      },
    },
  };
  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body.received).toBe(true);

  // First grant must land before we redeliver, so the duplicate deterministically
  // hits the event-dedupe path (PROCESSED) rather than racing in-flight work.
  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 1 });

  const res2 = await Payments.sendStripeWebhook(payloadObj);
  expect(res2.status).toBe(200);
  expect(res2.body).toEqual({ received: true, deduplicated: true });

  // After the deduplicated redelivery, quantity stays at a single grant.
  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 1 });
});

it("sends a payment receipt email for one-time purchases", async ({ expect }) => {
  const projectDisplayName = "Payments Receipt Email Test";
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const itemId = "receipt-credits";
  const productId = "receipt-ot";
  const product = {
    displayName: "Receipt Credits Pack",
    customerType: "user",
    serverOnly: false,
    stackable: true,
    prices: { one: { USD: "500" } },
    includedItems: { [itemId]: { quantity: 1 } },
  };

  await Project.updateConfig({
    payments: {
      items: {
        [itemId]: { displayName: "Credits", customerType: "user" },
      },
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const receiptLink = "https://example.com/receipt/pi_test_receipt_1";
  const paymentIntentId = "pi_test_receipt_1";
  const payloadObj = {
    id: uniqueEventId("receipt"),
    type: "payment_intent.succeeded",
    created: Math.floor(new Date().getTime() / 1000),
    account: accountId,
    data: {
      object: {
        id: paymentIntentId,
        customer: userId,
        amount_received: 500,
        currency: "usd",
        charges: {
          data: [{ receipt_url: receiptLink }],
        },
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
        metadata: {
          productId,
          product: JSON.stringify(product),
          customerId: userId,
          customerType: "user",
          purchaseQuantity: "2",
          purchaseKind: "ONE_TIME",
          priceId: "one",
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  const email = await waitForOutboxEmail(`Your receipt from ${projectDisplayName}`);
  expect(email.variables).toMatchInlineSnapshot(`
    {
      "amount": "USD 5.00",
      "productName": "Receipt Credits Pack",
      "quantity": 2,
      "receiptLink": "https://example.com/receipt/pi_test_receipt_1",
    }
  `);
});

it("sends exactly one receipt when Stripe redelivers the same event", async ({ expect }) => {
  // Regression test for the duplicate-receipt bug: Stripe delivers at-least-once,
  // and slow synchronous processing used to time out and trigger redeliveries,
  // each re-sending the receipt fan-out. The StripeWebhookEvent dedupe must keep
  // the fan-out to exactly once per event id.
  const projectDisplayName = `Receipt Idempotency ${randomUUID()}`;
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const itemId = "idem-receipt-credits";
  const productId = "idem-receipt-ot";
  const product = {
    displayName: "Idem Receipt Pack",
    customerType: "user",
    serverOnly: false,
    stackable: true,
    prices: { one: { USD: "500" } },
    includedItems: { [itemId]: { quantity: 1 } },
  };

  await Project.updateConfig({
    payments: {
      items: {
        [itemId]: { displayName: "Credits", customerType: "user" },
      },
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const receiptLink = "https://example.com/receipt/pi_idem_receipt";
  const eventId = uniqueEventId("idem_receipt");
  const payloadObj = {
    id: eventId,
    type: "payment_intent.succeeded",
    created: Math.floor(new Date().getTime() / 1000),
    account: accountId,
    data: {
      object: {
        id: "pi_idem_receipt",
        customer: userId,
        amount_received: 500,
        currency: "usd",
        charges: { data: [{ receipt_url: receiptLink }] },
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
        metadata: {
          productId,
          product: JSON.stringify(product),
          customerId: userId,
          customerType: "user",
          purchaseQuantity: "1",
          purchaseKind: "ONE_TIME",
          priceId: "one",
        },
      },
    },
  };

  const first = await Payments.sendStripeWebhook(payloadObj);
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ received: true });

  // Wait for the receipt to land, which proves the first event finished
  // processing (and is now PROCESSED), so the redeliveries deterministically
  // take the dedupe path.
  const subject = `Your receipt from ${projectDisplayName}`;
  await waitForOutboxEmail(subject);

  for (let i = 0; i < 2; i++) {
    const redelivery = await Payments.sendStripeWebhook(payloadObj);
    expect(redelivery.status).toBe(200);
    expect(redelivery.body).toEqual({ received: true, deduplicated: true });
  }

  // Give any (incorrectly) re-triggered fan-out a chance to show up, then assert
  // there is still exactly one receipt email for this project.
  await wait(1500);
  const receipts = await getOutboxEmails({ subject });
  expect(receipts.length).toBe(1);
});

it("sends a payment failed email for invoice.payment_failed", async ({ expect }) => {
  const projectDisplayName = "Payments Failed Email Test";
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const productId = "sub-failed";
  const product = {
    displayName: "Pro Plan",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "1500", interval: [1, "month"] } },
    includedItems: {},
  };

  await Project.updateConfig({
    payments: {
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const invoiceId = "in_test_failed_1";
  const invoiceUrl = "https://example.com/billing/update";
  const payloadObj = {
    id: uniqueEventId("invoice_failed"),
    type: "invoice.payment_failed",
    account: accountId,
    data: {
      object: {
        id: invoiceId,
        customer: "cus_failed_1",
        amount_due: 1500,
        currency: "usd",
        status: "uncollectible",
        hosted_invoice_url: invoiceUrl,
        lines: {
          data: [
            {
              description: "Pro Plan",
            },
          ],
        },
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  const email = await waitForOutboxEmail(`Payment failed for ${projectDisplayName}`);
  expect(email.variables).toMatchInlineSnapshot(`
    {
      "amount": "USD 15.00",
      "invoiceUrl": "https://example.com/billing/update",
      "productName": "Pro Plan",
    }
  `);
});

it("skips payment failed email when invoice is not uncollectible", async ({ expect }) => {
  const projectDisplayName = "Payments Failed Email Open Invoice Test";
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const productId = "sub-failed-open";
  const product = {
    displayName: "Starter Plan",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "900", interval: [1, "month"] } },
    includedItems: {},
  };

  await Project.updateConfig({
    payments: {
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const invoiceId = "in_test_failed_open_1";
  const invoiceUrl = "https://example.com/billing/open";
  const payloadObj = {
    id: uniqueEventId("invoice_failed_open"),
    type: "invoice.payment_failed",
    account: accountId,
    data: {
      object: {
        id: invoiceId,
        customer: "cus_failed_open_1",
        amount_due: 900,
        currency: "usd",
        status: "open",
        hosted_invoice_url: invoiceUrl,
        lines: {
          data: [
            {
              description: "Starter Plan",
            },
          ],
        },
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [] },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  await waitForNoOutboxEmail(`Payment failed for ${projectDisplayName}`);
});


it("syncs subscriptions from webhook and is idempotent", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();

  const itemId = "subscription-credits";
  const productId = "sub-monthly";
  const product = {
    displayName: "Monthly Subscription",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "1000", interval: [1, "month"] } },
    includedItems: { [itemId]: { quantity: 1 } },
  };

  await Project.updateConfig({
    payments: {
      items: {
        [itemId]: { displayName: "Credits", customerType: "user" },
      },
      products: {
        [productId]: product,
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const getBefore = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/${itemId}`, {
    accessType: "client",
  });
  expect(getBefore.status).toBe(200);
  expect(getBefore.body.quantity).toBe(0);

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const nowSec = Math.floor(Date.now() / 1000);
  const subscription = {
    id: "sub_test_1",
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
      productId,
      product: JSON.stringify(product),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const payloadObj = {
    id: uniqueEventId("sub_sync"),
    type: "invoice.paid",
    account: accountId,
    data: {
      object: {
        customer: "cus_sub_sync_1",
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [subscription] },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body.received).toBe(true);

  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 1 });

  // Redelivery of the same event id is deduplicated and leaves state untouched.
  const res2 = await Payments.sendStripeWebhook(payloadObj);
  expect(res2.status).toBe(200);
  expect(res2.body).toEqual({ received: true, deduplicated: true });

  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 1 });
});


it("updates a user's subscriptions via webhook (add then remove)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();

  const itemId = "subscription-seat";
  const productId = "pro-monthly";
  const product = {
    displayName: "Pro Monthly",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "1500", interval: [1, "month"] } },
    includedItems: { [itemId]: { quantity: 1, expires: "when-purchase-expires" } },
  };

  await Project.updateConfig({
    payments: {
      items: {
        [itemId]: { displayName: "Seat", customerType: "user" },
      },
      products: {
        [productId]: product,
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  const before = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/${itemId}`, {
    accessType: "client",
  });
  expect(before.status).toBe(200);
  expect(before.body.quantity).toBe(0);

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const idSuffix = randomUUID().replace(/-/g, "");
  const stripeCustomerId = `cus_update_${idSuffix}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const activeSubscription = {
    id: `sub_update_${idSuffix}`,
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
      productId,
      product: JSON.stringify(product),
      priceId: "monthly",
    },
    cancel_at_period_end: false,
  };

  const payloadAdd = {
    id: uniqueEventId("sub_add"),
    type: "invoice.paid",
    account: accountId,
    data: {
      object: {
        customer: stripeCustomerId,
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [activeSubscription] },
        },
      },
    },
  };

  const resAdd = await Payments.sendStripeWebhook(payloadAdd);
  expect(resAdd.status).toBe(200);
  expect(resAdd.body).toEqual({ received: true });

  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 1 });

  // Cancel the subscription "now". The included-item grant is emitted effective
  // at the subscription row's DB creation time (i.e. when the add webhook above
  // was processed), so the cancellation must end the subscription strictly after
  // that — otherwise the grant's expiry would be ordered *before* the grant
  // itself and the seat would never drop. We capture the time after the add has
  // been confirmed and add one second: `floor(now)+1 > now > createdAt`, so the
  // ended_at (in whole Stripe seconds) is guaranteed to land after the row's
  // createdAt while still being at most ~1s ahead of the subsequent poll, which
  // the poll loop tolerates. Real Stripe likewise always sets canceled_at/
  // ended_at on a terminal-status subscription.
  const cancelSec = Math.floor(Date.now() / 1000) + 1;
  const canceledSubscription = {
    ...activeSubscription,
    status: "canceled",
    canceled_at: cancelSec,
    ended_at: cancelSec,
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: nowSec - 60,
          current_period_end: cancelSec,
        },
      ],
    },
  };

  const payloadRemove = {
    id: uniqueEventId("sub_remove"),
    type: "customer.subscription.updated",
    account: accountId,
    data: {
      object: {
        customer: stripeCustomerId,
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [canceledSubscription] },
        },
      },
    },
  };

  const resRemove = await Payments.sendStripeWebhook(payloadRemove);
  expect(resRemove.status).toBe(200);
  expect(resRemove.body).toEqual({ received: true });

  await waitForItemQuantity({ customerType: "user", customerId: userId, itemId, expected: 0 });
});


it("does NOT auto-grant `free` when a non-internal tenancy's sub is canceled via webhook", async ({ expect }) => {
  // Guard test for the `tenancy.project.id === "internal"` gate: a customer
  // project's own Stripe cancellations must never cause a `free` sub to
  // appear in their tenancy.
  await Project.createAndSwitch();
  await Payments.setup();

  const customProductId = "customer-product";
  const customItemId = "customer-seat";
  const customProduct = {
    displayName: "Customer Product",
    customerType: "team",
    productLineId: "customer-plans",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "1000", interval: [1, "month"] } },
    includedItems: { [customItemId]: { quantity: 1, expires: "when-purchase-expires" } },
  };
  await Project.updateConfig({
    payments: {
      productLines: { "customer-plans": { displayName: "Customer Plans", customerType: "team" } },
      items: { [customItemId]: { displayName: "Customer Seat", customerType: "team" } },
      products: { [customProductId]: customProduct },
    },
  });

  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator({ accessType: "server" });

  const accountInfo = await niceBackendFetch(
    "/api/latest/internal/payments/stripe/account-info",
    { accessType: "admin" },
  );
  const accountId = accountInfo.body.account_id;
  const createUrlResponse = await niceBackendFetch(
    "/api/latest/payments/purchases/create-purchase-url",
    {
      method: "POST",
      accessType: "client",
      body: { customer_type: "team", customer_id: teamId, product_id: customProductId },
    },
  );
  const projectTenancyId = (createUrlResponse.body as { url: string }).url
    .split("/purchase/")[1].split("_")[0];

  const nowSec = Math.floor(Date.now() / 1000);
  const webhookResponse = await Payments.sendStripeWebhook({
    id: uniqueEventId("customer_cancel"),
    type: "customer.subscription.deleted",
    account: accountId,
    data: {
      object: {
        customer: "cus_customer_cancel",
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: projectTenancyId } },
          "customers.retrieve": { metadata: { customerId: teamId, customerType: "TEAM" } },
          "subscriptions.list": { data: [{
            id: "sub_customer_cancel",
            status: "canceled",
            items: { data: [{
              quantity: 1,
              current_period_start: nowSec - 2 * 60,
              current_period_end: nowSec - 60,
            }] },
            metadata: { productId: customProductId, product: JSON.stringify(customProduct), priceId: "monthly" },
            cancel_at_period_end: false,
          }] },
        },
      },
    },
  });
  expect(webhookResponse.status).toBe(200);
  await wait(2000);

  // Guard: no `free` product should ever appear in a customer-project tenancy's
  // ownedProducts, since the gate short-circuits before we touch anything here.
  const subsResponse = await niceBackendFetch(
    `/api/v1/payments/products/team/${teamId}`,
    { accessType: "server" },
  );
  expect(subsResponse.status).toBe(200);
  const items = (subsResponse.body as { items: Array<{ id: string | null }> }).items;
  expect(items.map((i) => i.id)).not.toContain("free");
});

it("sends a trial ending soon email for customer.subscription.trial_will_end", async ({ expect }) => {
  const projectDisplayName = "Trial Will End Email Test";
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const productId = "trial-product";
  const product = {
    displayName: "Pro Trial Plan",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: {
      monthly: {
        USD: "19.00",
        interval: [1, "month"],
        freeTrial: [14, "day"],
      },
    },
    includedItems: {},
  };

  await Project.updateConfig({
    payments: {
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const trialEnd = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const payloadObj = {
    id: uniqueEventId("trial_will_end"),
    type: "customer.subscription.trial_will_end",
    account: accountId,
    data: {
      object: {
        id: "sub_trial_will_end",
        customer: "cus_trial_will_end",
        status: "trialing",
        trial_end: trialEnd,
        metadata: {
          productId,
          product: JSON.stringify(product),
          priceId: "monthly",
        },
        items: {
          data: [{
            quantity: 1,
            current_period_start: nowSec,
            current_period_end: trialEnd,
          }],
        },
        cancel_at_period_end: false,
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [{
            id: "sub_trial_will_end",
            status: "trialing",
            trial_end: trialEnd,
            items: { data: [{
              quantity: 1,
              current_period_start: nowSec,
              current_period_end: trialEnd,
            }] },
            metadata: { productId, product: JSON.stringify(product), priceId: "monthly" },
            cancel_at_period_end: false,
          }] },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  const email = await waitForOutboxEmail("Your free trial for Pro Trial Plan is ending soon");
  expect(email.variables).toMatchInlineSnapshot(`
    {
      "productName": "Pro Trial Plan",
      "trialEndDate": "2026-01-15T12:00:00.000Z",
    }
  `);
});

it("does not send a payment receipt for a $0 invoice (e.g. free trial create)", async ({ expect }) => {
  const projectDisplayName = "Zero Dollar Receipt Skip Test";
  await Project.createAndSwitch({ display_name: projectDisplayName });
  await Payments.setup();

  const productId = "zero-receipt-sub";
  const product = {
    displayName: "Trial Plan",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "19.00", interval: [1, "month"], freeTrial: [7, "day"] } },
    includedItems: {},
  };

  await Project.updateConfig({
    payments: {
      products: {
        [productId]: product,
      },
    },
  });

  const mailbox = await bumpEmailAddress();
  const { userId } = await Auth.fastSignUp({
    primary_email: mailbox.emailAddress,
    primary_email_verified: true,
  });

  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", {
    accessType: "admin",
  });
  expect(accountInfo.status).toBe(200);
  const accountId: string = accountInfo.body.account_id;

  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: productId,
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const purchaseUrl = (createUrlResponse.body as { url: string }).url;
  const fullCode = purchaseUrl.split("/purchase/")[1];
  const stackTestTenancyId = fullCode.split("_")[0];

  const nowSec = Math.floor(Date.now() / 1000);
  const payloadObj = {
    id: uniqueEventId("zero_receipt"),
    type: "invoice.payment_succeeded",
    account: accountId,
    data: {
      object: {
        id: "in_zero_trial_create",
        customer: "cus_zero_trial",
        amount_paid: 0,
        currency: "usd",
        billing_reason: "subscription_create",
        hosted_invoice_url: "https://example.com/invoice/zero",
        lines: {
          data: [{ description: "Trial Plan", quantity: 1 }],
        },
        stack_stripe_mock_data: {
          "accounts.retrieve": { metadata: { tenancyId: stackTestTenancyId } },
          "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
          "subscriptions.list": { data: [{
            id: "sub_zero_trial",
            status: "trialing",
            items: { data: [{
              quantity: 1,
              current_period_start: nowSec,
              current_period_end: nowSec + 7 * 24 * 60 * 60,
            }] },
            metadata: { productId, product: JSON.stringify(product), priceId: "monthly" },
            cancel_at_period_end: false,
          }] },
        },
      },
    },
  };

  const res = await Payments.sendStripeWebhook(payloadObj);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true });

  await wait(1500);
  const receipts = await getOutboxEmails({ subject: `Your receipt from ${projectDisplayName}` });
  expect(receipts.length).toBe(0);
});
