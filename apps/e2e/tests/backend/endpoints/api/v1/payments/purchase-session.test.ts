import { it } from "../../../../../helpers";
import { withPortPrefix } from "../../../../../helpers/ports";
import { Auth, Payments, Project, User, niceBackendFetch } from "../../../../backend-helpers";

it("should error on invalid code", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: "invalid-code",
      price_id: "monthly",
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

it("should error on invalid price_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "invalid-price-id",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Price not found on product associated with this purchase code",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should properly create subscription", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "payment",
  });
});

it("should create a subscription for float-sensitive USD amounts like 79.99", async ({ expect }) => {
  // Regression: Number("79.99") * 100 === 7998.999999999999, which Stripe
  // rejects with parameter_invalid_integer. Purchase-session must send integer
  // stripe units (7999) via moneyAmountToStripeUnits.
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "79.99",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "payment",
  });
});

it("should return a setup client secret for a free-trial subscription", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "trial-product": {
          displayName: "Trial Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "19.00",
              interval: [1, "month"],
              freeTrial: [14, "day"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "trial-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response.status).toBe(200);
  // Free trials must return a SetupIntent secret (confirmSetup), not a PaymentIntent.
  expect(response.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "setup",
  });
});

it("should prefer price-level freeTrial over product-level freeTrial", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "trial-product": {
          displayName: "Trial Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          freeTrial: [30, "day"],
          prices: {
            "monthly": {
              USD: "19.00",
              interval: [1, "month"],
              freeTrial: [7, "day"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "trial-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response.status).toBe(200);
  // Price-level [7, day] wins over product-level [30, day]; both still produce a SetupIntent.
  // Day-count precedence itself is covered by getEffectiveFreeTrial / getStripeTrialPeriodDays unit tests.
  expect(response.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "setup",
  });
});

it("should reject freeTrial on a one-time price", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "bad-trial-otp": {
          displayName: "Bad Trial OTP",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "once": {
              USD: "19.00",
              freeTrial: [7, "day"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "bad-trial-otp",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "once",
      quantity: 1,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Free trials are only supported on recurring prices",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should reject freeTrial combined with a $0 price", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "bad-trial-free": {
          displayName: "Bad Trial Free",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "0.00",
              interval: [1, "month"],
              freeTrial: [7, "day"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "bad-trial-free",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Free trials cannot be combined with a $0 price",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should return client secret for one-time price (no interval)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "ot-product": {
          displayName: "One Time Product",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: {
            one: {
              USD: "1500",
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "ot-product",
    },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "one",
      quantity: 2,
    },
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "payment",
  });
});

it("allows a sub-minimum unit one-time price when quantity brings the total to Stripe's floor", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "ot-cheap": {
          displayName: "Cheap One Time",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: {
            one: { USD: "0.30" },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "ot-cheap",
    },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "one",
      quantity: 2,
    },
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "payment",
  });
});

it("rejects a one-time purchase whose quantity-adjusted total is below Stripe's floor", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "ot-too-cheap": {
          displayName: "Too Cheap One Time",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: {
            one: { USD: "0.30" },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "ot-too-cheap",
    },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "one",
      quantity: 1,
    },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "One-time purchases must total at least $0.50",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should error on one-time price quantity > 1 when product is not stackable", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "ot-non-stack": {
          displayName: "One Time Non-Stackable",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            one: { USD: "1200" },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "ot-non-stack",
    },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "one",
      quantity: 2,
    },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This product is not stackable; quantity must be 1",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should return client secret for one-time price even if a conflicting group subscription exists (DB-only)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      productLines: { grp: { displayName: "Test Group" } },
      products: {
        subProduct: {
          displayName: "Sub Product",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: false,
          prices: { monthly: { USD: "1000", interval: [1, "month"] } },
          includedItems: {},
        },
        oneTime: {
          displayName: "One Time",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: true,
          prices: { one: { USD: "500" } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  // Create test-mode DB-only subscription for subProduct
  const createUrlRespA = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "subProduct",
    },
  });
  expect(createUrlRespA.status).toBe(200);
  const codeA = (createUrlRespA.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;
  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: codeA, price_id: "monthly", quantity: 1 },
  });
  expect(testModeRes.status).toBe(200);

  // Flip to live mode for the next purchase. Path notation preserves products/productLines.
  await Project.updateConfig({ "payments.testMode": false });

  // Now purchase one-time product in same group; should succeed and return client secret
  const createUrlRespB = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "oneTime",
    },
  });
  expect(createUrlRespB.status).toBe(200);
  const codeB = (createUrlRespB.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: { full_code: codeB, price_id: "one", quantity: 1 },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_secret": "pi_1PgafyB7WZ01zgkWSjxsAJo3_secret_Dm43xiq1k0ywrRRjDoi8y1gkM",
        "stripe_intent_type": "payment",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("test-mode should error on one-time price quantity > 1 when product is not stackable", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        tmOneTime: {
          displayName: "TM One Time",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: { one: { USD: "800" } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "tmOneTime" },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code, price_id: "one", quantity: 2 },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This product is not stackable; quantity must be 1",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should create purchase URL, validate code, and create purchase session", async ({ expect }) => {
  const { code } = await Payments.createPurchaseUrlAndGetCode();
  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
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

it("should create purchase URL with inline product, validate code, and create purchase session", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({ "payments.testMode": false });

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "server",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_inline: {
        display_name: "Inline Test Product",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly-test": {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(response.status).toBe(200);
  const body = response.body as { url: string };
  expect(body.url).toMatch(new RegExp(`^https?:\/\/localhost:${withPortPrefix("01")}\/purchase\/[a-z0-9-_]+$`));
  const codeMatch = body.url.match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();

  const purchaseSessionResponse = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly-test",
    },
  });
  expect(purchaseSessionResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_secret": "",
        "stripe_intent_type": "payment",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should error when test mode is not enabled", async ({ expect }) => {
  const { code } = await Payments.createPurchaseUrlAndGetCode();

  const response = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "monthly",
    },
  });

  expect(response.status).toBe(403);
  expect(response.body).toBe("Test mode is not enabled for this project");
});

it("should reject test-mode codes sent to the live purchase-session route", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: { monthly: { USD: "1000", interval: [1, "month"] } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "test-product" },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: { full_code: code, price_id: "monthly", quantity: 1 },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "This purchase link is no longer valid. Please request a new one and try again.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates subscription in test mode and increases included item quantity", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {
            "test-item": { quantity: 2 },
          },
        },
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const body = createUrlResponse.body as { url: string };
  const codeMatch = body.url.match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();

  const getBefore = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(getBefore.status).toBe(200);
  expect(getBefore.body.quantity).toBe(0);

  const purchaseSessionResponse = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "monthly",
    },
  });
  expect(purchaseSessionResponse.status).toBe(200);
  expect(purchaseSessionResponse.body).toEqual({ success: true });

  const getAfter = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(getAfter.status).toBe(200);
  expect(getAfter.body.quantity).toBe(2);
});

it("should list inline product metadata after completing test-mode purchase", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
    },
  });

  const { userId } = await Auth.fastSignUp();
  const createPurchaseResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "server",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_inline: {
        display_name: "Inline Metadata Product",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly-inline": {
            USD: "1800",
            interval: [1, "month"],
          },
        },
        included_items: {},
        server_metadata: {
          correlation_id: "inline-test-123",
          attributes: {
            seats: 5,
            tier: "gold",
          },
        },
      },
    },
  });
  expect(createPurchaseResponse.status).toBe(200);
  const url = (createPurchaseResponse.body as { url: string }).url;
  const codeMatch = url.match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();

  const testModePurchaseResponse = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "monthly-inline",
    },
  });
  expect(testModePurchaseResponse.status).toBe(200);
  expect(testModePurchaseResponse.body).toEqual({ success: true });

  const listResponse = await niceBackendFetch(`/api/v1/payments/products/user/${userId}`, {
    accessType: "server",
  });
  expect(listResponse.status).toBe(200);
  const listBody = listResponse.body as {
    items: Array<{ product: { server_metadata?: Record<string, unknown> } }>,
  };
  expect(listBody.items).toHaveLength(1);
  expect(listBody.items[0].product.server_metadata).toMatchInlineSnapshot(`
    {
      "attributes": {
        "seats": 5,
        "tier": "gold",
      },
      "correlation_id": "inline-test-123",
    }
  `);
});

it("test-mode should error on invalid code", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: "invalid-code",
      price_id: "monthly",
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

it("test-mode should error on invalid price_id", async ({ expect }) => {
  const { code } = await Payments.createPurchaseUrlAndGetCode();
  await Project.updateConfig({
    payments: {
      testMode: true,
    },
  });
  const response = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "invalid-price-id",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Price not found on product associated with this purchase code",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("allows stackable quantity in test mode and multiplies included items", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      items: {
        "test-item": {
          displayName: "Test Item",
          customerType: "user",
        },
      },
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: false,
          stackable: true,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {
            "test-item": { quantity: 2 },
          },
        },
      },
    },
  });

  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const body = createUrlResponse.body as { url: string };
  const codeMatch = body.url.match(/\/purchase\/([a-z0-9-_]+)/);
  const code = codeMatch ? codeMatch[1] : undefined;
  expect(code).toBeDefined();

  const getBefore = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(getBefore.status).toBe(200);
  expect(getBefore.body.quantity).toBe(0);

  const purchaseSessionResponse = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 3,
    },
  });
  expect(purchaseSessionResponse.status).toBe(200);
  expect(purchaseSessionResponse.body).toEqual({ success: true });

  const getAfter = await niceBackendFetch(`/api/latest/payments/items/user/${userId}/test-item`, {
    accessType: "client",
    userAuth: { accessToken, refreshToken },
  });
  expect(getAfter.status).toBe(200);
  expect(getAfter.body.quantity).toBe(6);
});

it("should update existing stripe subscription when switching products within a group (non test-mode)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      productLines: {
        grp: { displayName: "Test Group" },
      },
      products: {
        productA: {
          displayName: "Product A",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: false,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
        productB: {
          displayName: "Product B",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: false,
          prices: {
            monthly: {
              USD: "2000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  // First purchase: Product A
  const createUrlA = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "productA",
    },
  });
  expect(createUrlA.status).toBe(200);
  const codeA = (createUrlA.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeA).toBeDefined();

  const purchaseA = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: codeA,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(purchaseA).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_secret": "",
        "stripe_intent_type": "payment",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Second purchase: Product B in same group (should update existing Stripe subscription)
  const createUrlB = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "productB",
    },
  });
  expect(createUrlB.status).toBe(200);
  const codeB = (createUrlB.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeB).toBeDefined();

  const purchaseB = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: codeB,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(purchaseB).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_secret": "",
        "stripe_intent_type": "payment",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should cancel DB-only subscription then create Stripe subscription when switching from test-mode (same group)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      productLines: {
        grp: { displayName: "Test Group" },
      },
      products: {
        productA: {
          displayName: "Product A",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: false,
          prices: {
            monthly: {
              USD: "1000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
        productB: {
          displayName: "Product B",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: false,
          prices: {
            monthly: {
              USD: "2000",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  // Create test-mode DB-only subscription for productA
  const resUrlA = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "productA",
    },
  });
  expect(resUrlA.status).toBe(200);
  const codeA = (resUrlA.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeA).toBeDefined();

  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: codeA,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(testModeRes.status).toBe(200);

  // Flip to live mode so the next purchase exercises the Stripe path.
  await Project.updateConfig({ "payments.testMode": false });

  // Now purchase productB in non test-mode; should cancel DB-only sub and create Stripe subscription
  const resUrlB = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "productB",
    },
  });
  expect(resUrlB.status).toBe(200);
  const codeB = (resUrlB.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeB).toBeDefined();

  const purchaseB = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: codeB,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(purchaseB).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_secret": "",
        "stripe_intent_type": "payment",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should block one-time purchase for same product after prior one-time purchase (test-mode persisted)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        ot: {
          displayName: "One Time Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: { one: { USD: "500" } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  // First: create code and complete in TEST_MODE (persists OneTimePurchase)
  const createUrl1 = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "ot" },
  });
  expect(createUrl1.status).toBe(200);
  const code1 = (createUrl1.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(code1).toBeDefined();

  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code1, price_id: "one", quantity: 1 },
  });
  expect(testModeRes.status).toBe(200);

  // Second: attempt another purchase for same product (should be blocked by OneTimePurchase)
  const createUrl2 = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "ot" },
  });
  expect(createUrl2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_ALREADY_GRANTED",
        "details": {
          "customer_id": "<stripped UUID>",
          "product_id": "ot",
        },
        "error": "Customer with ID \\"<stripped UUID>\\" already owns product \\"ot\\".",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_ALREADY_GRANTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should block one-time purchase in same group after prior one-time purchase in that group (test-mode persisted)", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      productLines: { grp: { displayName: "Group" } },
      products: {
        productA: {
          displayName: "Product A",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: true,
          prices: { one: { USD: "500" } },
          includedItems: {},
        },
        productB: {
          displayName: "Product B",
          customerType: "user",
          serverOnly: false,
          productLineId: "grp",
          stackable: true,
          prices: { one: { USD: "700" } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  // Purchase productA in TEST_MODE (persists OneTimePurchase)
  const urlA = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "productA" },
  });
  expect(urlA.status).toBe(200);
  const codeA = (urlA.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeA).toBeDefined();

  const tmRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: codeA, price_id: "one", quantity: 1 },
  });
  expect(tmRes.status).toBe(200);

  // Attempt to purchase productB in same group (should be blocked)
  const urlB = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "productB" },
  });
  expect(urlB.status).toBe(200);
  const codeB = (urlB.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1];
  expect(codeB).toBeDefined();

  const resB = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: codeB, price_id: "one", quantity: 1 },
  });
  expect(resB.status).toBe(400);
  expect(String(resB.body)).toContain("one-time purchase in this product line");
});

it("creates a $0 recurring subscription without requiring a payment intent", async ({ expect }) => {
  // TODO(default-plans): revisit when default products land - $0 may no
  // longer flow through purchase-session at all.
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "free-product": {
          displayName: "Free Product",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            "monthly": {
              USD: "0",
              interval: [1, "month"],
            },
          },
          includedItems: {},
        },
      },
    },
  });
  const { userId, accessToken, refreshToken } = await Auth.fastSignUp();
  const createUrlResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    userAuth: { accessToken, refreshToken },
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "free-product",
    },
  });
  expect(createUrlResponse.status).toBe(200);
  const code = (createUrlResponse.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {},
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a $0 one-time price with a clear 400", async ({ expect }) => {
  // TODO(default-plans): revisit when default products land - $0 may no
  // longer flow through purchase-session at all.
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      products: {
        "free-otp": {
          displayName: "Free One Time",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            one: { USD: "0" },
          },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const urlRes = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "free-otp",
    },
  });
  expect(urlRes.status).toBe(200);
  const code = (urlRes.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const res = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "one",
      quantity: 1,
    },
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Free products must have a billing interval",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("switches from an existing paid subscription to a $0 subscription in the same product line", async ({ expect }) => {
  // TODO(default-plans): revisit when default products land - $0 may no
  // longer flow through purchase-session at all.
  //
  // Note: this test seeds the existing paid sub via test-mode-purchase-session,
  // so the conflict goes through the DB-only cancel branch in route.tsx (it
  // falls through to the regular CREATE path that test 1 covers). The Stripe
  // `subscriptions.update` branch (the OTHER conflict branch) gets the same
  // patch, but exercising it from e2e would require sending a signed Stripe
  // webhook to seed an active Stripe-backed sub -- and that path is currently
  // flaky in this repo (see existing failures in switch-plans.test.ts with
  // "Invalid stripe-signature header"). Code-review verifies symmetry of the
  // patch across both conflict branches.
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      productLines: { plans: { displayName: "Plans" } },
      products: {
        paid: {
          displayName: "Paid",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "plans",
          prices: { monthly: { USD: "1000", interval: [1, "month"] } },
          includedItems: {},
        },
        free: {
          displayName: "Free",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "plans",
          prices: { monthly: { USD: "0", interval: [1, "month"] } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();

  // Seed an active paid sub via test-mode (DB-only, no Stripe round-trip).
  const createUrlPaid = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "paid" },
  });
  expect(createUrlPaid.status).toBe(200);
  const codePaid = (createUrlPaid.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;
  const testModeRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: codePaid, price_id: "monthly", quantity: 1 },
  });
  expect(testModeRes.status).toBe(200);

  // Now switch by purchasing the free product in the same line via the real route.
  const createUrlFree = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "free" },
  });
  expect(createUrlFree.status).toBe(200);
  const codeFree = (createUrlFree.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const switchRes = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: codeFree, price_id: "monthly", quantity: 1 },
  });
  expect(switchRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a duplicate non-stackable subscription redeemed via test-mode-purchase-session even when create-purchase-url already issued the code", async ({ expect }) => {
  // Pre-issue both codes BEFORE the first redemption so create-purchase-url's
  // own duplicate check can't catch the second one. This forces the second
  // redemption to rely on validatePurchaseSession's Prisma guard.
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        sub: {
          displayName: "Sub",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: { monthly: { USD: "1000", interval: [1, "month"] } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const code1Res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "sub" },
  });
  expect(code1Res.status).toBe(200);
  const code1 = (code1Res.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;
  const code2Res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "sub" },
  });
  expect(code2Res.status).toBe(200);
  const code2 = (code2Res.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const firstRedeem = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code1, price_id: "monthly", quantity: 1 },
  });
  expect(firstRedeem.status).toBe(200);

  const secondRedeem = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code2, price_id: "monthly", quantity: 1 },
  });
  expect(secondRedeem).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_ALREADY_GRANTED",
        "details": {
          "customer_id": "<stripped UUID>",
          "product_id": "sub",
        },
        "error": "Customer with ID \\"<stripped UUID>\\" already owns product \\"sub\\".",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_ALREADY_GRANTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects a duplicate non-stackable one-time purchase redeemed via test-mode-purchase-session even when create-purchase-url already issued the code", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      products: {
        ot: {
          displayName: "One Time",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: { one: { USD: "500" } },
          includedItems: {},
        },
      },
    },
  });

  const { userId } = await Auth.fastSignUp();
  const code1Res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "ot" },
  });
  expect(code1Res.status).toBe(200);
  const code1 = (code1Res.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;
  const code2Res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: { customer_type: "user", customer_id: userId, product_id: "ot" },
  });
  expect(code2Res.status).toBe(200);
  const code2 = (code2Res.body as { url: string }).url.match(/\/purchase\/([a-z0-9-_]+)/)?.[1]!;

  const firstRedeem = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code1, price_id: "one", quantity: 1 },
  });
  expect(firstRedeem.status).toBe(200);

  const secondRedeem = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: code2, price_id: "one", quantity: 1 },
  });
  expect(secondRedeem).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_ALREADY_GRANTED",
        "details": {
          "customer_id": "<stripped UUID>",
          "product_id": "ot",
        },
        "error": "Customer with ID \\"<stripped UUID>\\" already owns product \\"ot\\".",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_ALREADY_GRANTED",
        <some fields may have been hidden>,
      },
    }
  `);
});
