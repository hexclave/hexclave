import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { it } from "../../../../../helpers";
import { withPortPrefix } from "../../../../../helpers/ports";
import { Auth, niceBackendFetch, Payments, Project } from "../../../../backend-helpers";

it("should not be able to create purchase URL without product_id or product_inline", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
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

it("should error for non-existent product_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "non-existent-product",
    },
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "PRODUCT_DOES_NOT_EXIST",
          "details": {
            "context": null,
            "product_id": "non-existent-product",
          },
          "error": "Product with ID \\"non-existent-product\\" does not exist.",
        },
        "headers": Headers {
          "x-stack-known-error": "PRODUCT_DOES_NOT_EXIST",
          <some fields may have been hidden>,
        },
      }
    `);
});

it("should error for invalid customer_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
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

  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "server",
    body: {
      customer_type: "team",
      customer_id: generateUuid(),
      product_id: "test-product",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        "details": {
          "actual_customer_type": "team",
          "customer_id": "<stripped UUID>",
          "product_customer_type": "user",
          "product_id": "test-product",
        },
        "error": "The team with ID \\"<stripped UUID>\\" is not a valid customer for the inline product that has been passed in. The product is configured to only be available for user customers, but the customer is a team.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should error for no connected stripe account in live mode", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Payments are not set up in this Hexclave project. Please go to the Hexclave dashboard and complete the Payments onboarding.",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
});

it("should create purchase URL in test mode without Stripe onboarding", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({
    payments: {
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(response.status).toBe(200);
  const body = response.body as { url: string };
  expect(body.url).toMatch(new RegExp(`^https?:\/\/localhost:${withPortPrefix("01")}\/purchase\/[a-z0-9-_]+$`));
});


it("should not allow product_inline when calling from client", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_inline: {
        display_name: "Inline Test Product",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly": {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(response.body).toMatchInlineSnapshot(`"Cannot specify product_inline when calling from client! Please call with a server API key, or use the product_id parameter."`);
});

it("should error for server-only product when calling from client", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      products: {
        "test-product": {
          displayName: "Test Product",
          customerType: "user",
          serverOnly: true,
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_DOES_NOT_EXIST",
        "details": {
          "context": "server_only",
          "product_id": "test-product",
        },
        "error": "Product with ID \\"test-product\\" is marked as server-only and cannot be accessed client side.",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_DOES_NOT_EXIST",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should allow product_inline when calling from server", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();

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
          "monthly": {
            USD: "1000",
            interval: [1, "month"],
          },
        },
        included_items: {},
      },
    },
  });
  expect(response.status).toBe(200);
  expect(response.body.url).toMatch(new RegExp(`^https?:\\/\\/localhost:${withPortPrefix("01")}\/purchase\/[a-z0-9-_]+$`));
});

it("should return inline product metadata when validating purchase code", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();

  const { userId } = await Auth.fastSignUp();
  const createResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "server",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_inline: {
        display_name: "Metadata Inline Product",
        customer_type: "user",
        server_only: true,
        prices: {
          "monthly-metadata": {
            USD: "1500",
            interval: [1, "month"],
          },
        },
        included_items: {},
        server_metadata: {
          reference_id: "ref-123",
          features: ["priority-support", "analytics"],
        },
      },
    },
  });
  expect(createResponse.status).toBe(200);
  const url = (createResponse.body as { url: string }).url;
  const codeMatch = url.match(/\/purchase\/([a-z0-9-_]+)/);
  const fullCode = codeMatch ? codeMatch[1] : undefined;
  expect(fullCode).toBeDefined();

  const validateResponse = await niceBackendFetch("/api/latest/payments/purchases/validate-code", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: fullCode,
    },
  });
  expect(validateResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "allow_promo_codes": false,
        "allow_stacking_promo_codes": false,
        "already_bought_non_stackable": false,
        "charges_enabled": null,
        "conflicting_products": [],
        "product": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "customer_type": "user",
          "display_name": "Metadata Inline Product",
          "included_items": {},
          "prices": {
            "monthly-metadata": {
              "USD": "1500",
              "interval": [
                1,
                "month",
              ],
            },
          },
          "server_metadata": {
            "features": [
              "priority-support",
              "analytics",
            ],
            "reference_id": "ref-123",
          },
          "server_only": true,
          "stackable": false,
        },
        "project_id": "<stripped UUID>",
        "project_logo_url": null,
        "replaces_stripe_subscription": false,
        "stripe_account_id": null,
        "test_mode": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should allow valid product_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
      return_url: "http://stack-test.localhost/after-purchase",
    },
  });
  expect(response.status).toBe(200);
  const body = response.body as { url: string };
  expect(body.url).toMatch(new RegExp(`^https?:\/\/localhost:${withPortPrefix("01")}\/purchase\/[a-z0-9-_]+\\?return_url=`));
  const urlObj = new URL(body.url);
  const returnUrl = urlObj.searchParams.get("return_url");
  expect(returnUrl).toBe("http://stack-test.localhost/after-purchase");
});

it("should error when customer already owns a non-stackable product", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
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

  const { userId } = await Auth.fastSignUp();
  const firstResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(firstResponse.status).toBe(200);
  const firstBody = firstResponse.body as { url: string };
  const firstUrl = new URL(firstBody.url);
  const fullCode = firstUrl.pathname.split("/").pop();
  expect(fullCode).toBeDefined();
  if (!fullCode) {
    throw new Error("Expected full purchase code");
  }

  const purchaseResponse = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: fullCode,
      price_id: "monthly",
      quantity: 1,
    },
  });
  expect(purchaseResponse.status).toBe(200);

  const secondResponse = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
    },
  });
  expect(secondResponse.status).toBe(400);
  expect(secondResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PRODUCT_ALREADY_GRANTED",
        "details": {
          "customer_id": "<stripped UUID>",
          "product_id": "test-product",
        },
        "error": "Customer with ID \\"<stripped UUID>\\" already owns product \\"test-product\\".",
      },
      "headers": Headers {
        "x-stack-known-error": "PRODUCT_ALREADY_GRANTED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should error when client tries to create purchase URL for another user", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
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

  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: generateUuid(),
      product_id: "test-product",
    },
  });
  expect(response.status).toBe(403);
  expect(response.body).toBe("Clients can only create purchase URLs for their own user or teams they have admin access to.");
});

it("should error for untrusted return_url", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
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

  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "test-product",
      return_url: "https://malicious.com/callback",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "REDIRECT_URL_NOT_WHITELISTED",
        "details": { "redirect_url": "https://malicious.com/callback" },
        "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
      },
      "headers": Headers {
        "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
        <some fields may have been hidden>,
      },
    }
  `);
});
