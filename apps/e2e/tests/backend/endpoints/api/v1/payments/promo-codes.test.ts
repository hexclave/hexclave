import { it } from "../../../../../helpers";
import { Auth, Payments, Project, niceBackendFetch } from "../../../../backend-helpers";

async function setupOtpProject() {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      allowPromoCodes: true,
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
        "cheap-otp": {
          displayName: "Cheap OTP",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            single: { USD: "10.00" },
          },
          includedItems: {},
        },
        "plan-a": {
          displayName: "Plan A",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "plans",
          prices: {
            monthly: { USD: "20.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
        "plan-b": {
          displayName: "Plan B",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          productLineId: "plans",
          prices: {
            monthly: { USD: "40.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
      },
      productLines: {
        plans: { displayName: "Plans" },
      },
    },
  });
}

async function createPromo(body: Record<string, unknown>) {
  return await niceBackendFetch("/api/latest/internal/payments/promo-codes", {
    method: "POST",
    accessType: "admin",
    body,
  });
}

function defaultPromoBody(overrides: Record<string, unknown> = {}) {
  return {
    code_name: "SAVE10",
    discount_type: "percent",
    discount_amount: 10,
    applicable_product_ids: null,
    max_redemptions: null,
    subscription_behavior: "first_payment",
    subscription_discount_duration_months: null,
    availability_type: "always",
    starts_at_millis: null,
    ends_at_millis: null,
    ...overrides,
  };
}

async function createPurchaseCode(options: { userId: string, productId: string, allowPromoCodes?: boolean, allowStackingPromoCodes?: boolean }) {
  const res = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: options.userId,
      product_id: options.productId,
      allow_promo_codes: options.allowPromoCodes === true,
      allow_stacking_promo_codes: options.allowStackingPromoCodes === true,
    },
  });
  if (res.status !== 200 || typeof res.body.url !== "string") {
    throw new Error(`create-purchase-url failed: ${JSON.stringify(res.body)}`);
  }
  const codeMatch = res.body.url.match(/\/purchase\/([a-z0-9-_]+)/);
  if (codeMatch?.[1] == null) {
    throw new Error(`create-purchase-url returned an unexpected URL: ${res.body.url}`);
  }
  return { response: res, code: codeMatch[1] };
}

it("creates a promo code and rejects a duplicate name as a KnownError", async ({ expect }) => {
  await setupOtpProject();
  const created = await createPromo(defaultPromoBody());
  expect(created.status).toBe(200);
  expect(created.body.code_name).toBe("SAVE10");
  expect(created.body.status).toBe("active");

  const duplicate = await createPromo(defaultPromoBody());
  expect(duplicate).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PROMO_CODE_CODE_NAME_ALREADY_EXISTS",
        "details": { "code_name": "SAVE10" },
        "error": "A promo code named \\"SAVE10\\" already exists in this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "PROMO_CODE_CODE_NAME_ALREADY_EXISTS",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid create payloads as KnownErrors, not 500s", async ({ expect }) => {
  await setupOtpProject();
  const emptyName = await createPromo(defaultPromoBody({ code_name: "   " }));
  expect(emptyName.status).toBe(400);
  expect(emptyName.body.code).toBe("PROMO_CODE_INVALID");

  const overPercent = await createPromo(defaultPromoBody({ code_name: "TOO_MUCH", discount_amount: 150 }));
  expect(overPercent.status).toBe(400);
  expect(overPercent.body.code).toBe("PROMO_CODE_INVALID");

  const overAmount = await createPromo(defaultPromoBody({
    code_name: "TOO_RICH",
    discount_type: "amount",
    discount_amount: 1_000_000,
  }));
  expect(overAmount.status).toBe(400);
});

it("pauses, resumes, and ends a promo code", async ({ expect }) => {
  await setupOtpProject();
  const created = await createPromo(defaultPromoBody({ code_name: "PAUSEME" }));
  expect(created.status).toBe(200);
  const id = created.body.id as string;

  const paused = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${id}/pause`, {
    method: "POST",
    accessType: "admin",
  });
  expect(paused.status).toBe(200);
  expect(paused.body.status).toBe("paused");

  const pauseAgain = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${id}/pause`, {
    method: "POST",
    accessType: "admin",
  });
  expect(pauseAgain.status).toBe(400);
  expect(pauseAgain.body.code).toBe("PROMO_CODE_CANNOT_PAUSE");

  const resumed = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${id}/resume`, {
    method: "POST",
    accessType: "admin",
  });
  expect(resumed.status).toBe(200);
  expect(resumed.body.status).toBe("active");
  expect(resumed.body.paused_at_millis).toBeNull();

  const resumeAgain = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${id}/resume`, {
    method: "POST",
    accessType: "admin",
  });
  expect(resumeAgain.status).toBe(400);
  expect(resumeAgain.body.code).toBe("PROMO_CODE_CANNOT_RESUME");

  const ended = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${id}/end`, {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  expect(ended.status).toBe(200);
  expect(ended.body.status).toBe("ended");
});

it("rejects redeeming a promo after its availability window", async ({ expect }) => {
  await setupOtpProject();
  const expired = await createPromo(defaultPromoBody({
    code_name: "WINDOWED",
    availability_type: "between_dates",
    starts_at_millis: Date.now() - 48 * 60 * 60 * 1000,
    ends_at_millis: Date.now() - 24 * 60 * 60 * 1000,
  }));
  expect(expired.status).toBe(200);
  expect(expired.body.status).toBe("expired");

  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      promo_codes: ["WINDOWED"],
    },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("PROMO_CODE_EXPIRED");

  const pauseExpired = await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${expired.body.id}/pause`, {
    method: "POST",
    accessType: "admin",
  });
  expect(pauseExpired.status).toBe(400);
  expect(pauseExpired.body.code).toBe("PROMO_CODE_CANNOT_PAUSE");

  const scheduled = await createPromo(defaultPromoBody({
    code_name: "TOMORROW",
    availability_type: "between_dates",
    starts_at_millis: Date.now() + 24 * 60 * 60 * 1000,
    ends_at_millis: Date.now() + 48 * 60 * 60 * 1000,
  }));
  expect(scheduled.status).toBe(200);
  expect(scheduled.body.status).toBe("scheduled");
  const notYet = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      promo_codes: ["TOMORROW"],
    },
  });
  expect(notYet.status).toBe(400);
  expect(notYet.body.code).toBe("PROMO_CODE_NOT_YET_AVAILABLE");
});

it("validate-promo-codes applies a percent discount and rejects stacking when disabled", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({ code_name: "TENOFF" }));
  await createPromo(defaultPromoBody({ code_name: "FIVEOFF", discount_amount: 5 }));
  const { userId } = await Auth.fastSignUp();
  const { response: urlRes, code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  expect(urlRes.status).toBe(200);

  const valid = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      quantity: 1,
      promo_codes: ["tenoff"],
    },
  });
  expect(valid.status).toBe(200);
  expect(valid.body.applied_code_names).toEqual(["TENOFF"]);
  expect(valid.body.original_amount).toBe("50.00");
  expect(valid.body.net_amount).toBe("45.00");
  expect(valid.body.recurring_amount).toBe("45.00");

  const stacked = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      quantity: 1,
      promo_codes: ["TENOFF", "FIVEOFF"],
    },
  });
  expect(stacked.status).toBe(403);
  expect(stacked.body.code).toBe("PROMO_CODE_STACKING_DISABLED");
});

it("validate-promo-codes reports a higher recurring amount when codes are first-payment only", async ({ expect }) => {
  await setupOtpProject();
  await Project.updateConfig({ "payments.allowStackingPromoCodes": true });
  await createPromo(defaultPromoBody({
    code_name: "HALF",
    discount_type: "percent",
    discount_amount: 50,
    subscription_behavior: "first_payment",
  }));
  await createPromo(defaultPromoBody({
    code_name: "SIX",
    discount_type: "amount",
    discount_amount: 6,
    subscription_behavior: "first_payment",
  }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({
    userId,
    productId: "plan-a",
    allowPromoCodes: true,
    allowStackingPromoCodes: true,
  });
  const valid = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
      promo_codes: ["HALF", "SIX"],
    },
  });
  expect(valid.status).toBe(200);
  expect(valid.body.original_amount).toBe("20.00");
  expect(valid.body.net_amount).toBe("4.00");
  expect(valid.body.recurring_amount).toBe("20.00");
});

it("rejects a promo on validate when the code is paused", async ({ expect }) => {
  await setupOtpProject();
  const created = await createPromo(defaultPromoBody({ code_name: "PAUSED" }));
  await niceBackendFetch(`/api/latest/internal/payments/promo-codes/${created.body.id}/pause`, {
    method: "POST",
    accessType: "admin",
  });
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      promo_codes: ["PAUSED"],
    },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("PROMO_CODE_PAUSED");
});

it("grants a 100% off OTP in test mode and counts a succeeded redemption", async ({ expect }) => {
  await setupOtpProject();
  const created = await createPromo(defaultPromoBody({
    code_name: "FREE100",
    discount_type: "percent",
    discount_amount: 100,
  }));
  expect(created.status).toBe(200);
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  const purchase = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: {
      full_code: code,
      price_id: "single",
      quantity: 1,
      promo_codes: ["FREE100"],
    },
  });
  expect(purchase.status).toBe(200);

  const listed = await niceBackendFetch("/api/latest/internal/payments/promo-codes", {
    accessType: "admin",
  });
  expect(listed.status).toBe(200);
  const promo = listed.body.promo_codes.find((row: { code_name: string }) => row.code_name === "FREE100");
  expect(promo.num_redemptions).toBe(1);
});

it("rejects OTP net below the one-time $0.50 minimum", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({
    code_name: "ALMOST",
    discount_type: "amount",
    discount_amount: 9.60,
  }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "cheap-otp", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      promo_codes: ["ALMOST"],
    },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("PROMO_CODE_DISCOUNT_BELOW_MINIMUM");
});

it("rejects a second redemption after max_redemptions is consumed", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({
    code_name: "ONCE",
    max_redemptions: 1,
  }));
  const first = await Auth.fastSignUp();
  const firstCode = await createPurchaseCode({ userId: first.userId, productId: "otp-product", allowPromoCodes: true });
  const firstPurchase = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: firstCode.code, price_id: "single", quantity: 1, promo_codes: ["ONCE"] },
  });
  expect(firstPurchase.status).toBe(200);

  const second = await Auth.fastSignUp();
  const secondCode = await createPurchaseCode({ userId: second.userId, productId: "otp-product", allowPromoCodes: true });
  const secondPurchase = await niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
    method: "POST",
    accessType: "admin",
    body: { full_code: secondCode.code, price_id: "single", quantity: 1, promo_codes: ["ONCE"] },
  });
  expect(secondPurchase.status).toBe(400);
  expect(secondPurchase.body.code).toBe("PROMO_CODE_REDEMPTION_LIMIT_REACHED");
});

it("only one of two concurrent last redemptions can reserve", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({
    code_name: "LASTONE",
    max_redemptions: 1,
  }));
  const first = await Auth.fastSignUp();
  const firstCode = await createPurchaseCode({ userId: first.userId, productId: "otp-product", allowPromoCodes: true });
  const second = await Auth.fastSignUp();
  const secondCode = await createPurchaseCode({ userId: second.userId, productId: "otp-product", allowPromoCodes: true });
  const [a, b] = await Promise.all([
    niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
      method: "POST",
      accessType: "admin",
      body: { full_code: firstCode.code, price_id: "single", quantity: 1, promo_codes: ["LASTONE"] },
    }),
    niceBackendFetch("/api/latest/internal/payments/test-mode-purchase-session", {
      method: "POST",
      accessType: "admin",
      body: { full_code: secondCode.code, price_id: "single", quantity: 1, promo_codes: ["LASTONE"] },
    }),
  ]);
  const statuses = [a.status, b.status].sort((first, second) => first - second);
  expect(statuses).toEqual([200, 400]);
  const failed = a.status === 400 ? a : b;
  expect(failed.body.code).toBe("PROMO_CODE_REDEMPTION_LIMIT_REACHED");

  const winner = a.status === 200 ? first : second;
  const loser = a.status === 400 ? first : second;
  const listOwned = (userId: string) => niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    accessType: "server",
  });
  const [winnerProducts, loserProducts] = await Promise.all([
    listOwned(winner.userId),
    listOwned(loser.userId),
  ]);
  expect(winnerProducts.status).toBe(200);
  expect(loserProducts.status).toBe(200);
  const ownedIds = (items: unknown) => {
    if (!Array.isArray(items)) {
      throw new Error(`expected products items array, got ${JSON.stringify(items)}`);
    }
    return items.map((item) => {
      if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string") {
        throw new Error(`expected product item with id, got ${JSON.stringify(item)}`);
      }
      return item.id;
    });
  };
  expect(ownedIds(winnerProducts.body.items)).toContain("otp-product");
  expect(ownedIds(loserProducts.body.items)).not.toContain("otp-product");
});

it("grants a 100% off OTP via purchase-session without a client secret", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      allowPromoCodes: true,
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
    },
  });
  await createPromo(defaultPromoBody({
    code_name: "FREE100",
    discount_amount: 100,
  }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      quantity: 1,
      promo_codes: ["FREE100"],
    },
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({});
});

it("returns a SetupIntent when a 100% first-payment promo zeros a paid subscription", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: false,
      allowPromoCodes: true,
      products: {
        "plan-a": {
          displayName: "Plan A",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: { USD: "20.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
      },
    },
  });
  await createPromo(defaultPromoBody({
    code_name: "FREEFIRST",
    discount_amount: 100,
    subscription_behavior: "first_payment",
  }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "plan-a", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/purchase-session", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      quantity: 1,
      promo_codes: ["FREEFIRST"],
    },
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    client_secret: expect.any(String),
    stripe_intent_type: "setup",
  });
});

it("switch QA 4–7: stacking off, fake/inapplicable, all-or-nothing, empty names", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({ code_name: "SWITCH10" }));
  await createPromo(defaultPromoBody({
    code_name: "PLANONLY",
    applicable_product_ids: ["plan-a"],
  }));
  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "plan-a", quantity: 1 },
  });

  const switchToPlanB = (body: Record<string, unknown>) => niceBackendFetch(`/api/latest/payments/products/user/${userId}/switch`, {
    method: "POST",
    accessType: "client",
    body: {
      from_product_id: "plan-a",
      to_product_id: "plan-b",
      ...body,
    },
  });
  const validateForPlanB = (body: Record<string, unknown>) => niceBackendFetch(`/api/latest/payments/products/user/${userId}/validate-promo-codes`, {
    method: "POST",
    accessType: "client",
    body: {
      product_id: "plan-b",
      ...body,
    },
  });
  const redemptionCount = async (codeName: string) => {
    const listed = await niceBackendFetch("/api/latest/internal/payments/promo-codes", { accessType: "admin" });
    const promo = listed.body.promo_codes.find((row: { code_name: string }) => row.code_name === codeName);
    return promo.num_redemptions as number;
  };

  // 4) stacking disabled + 2+ names
  const stackedValidate = await validateForPlanB({
    promo_codes: ["SWITCH10", "PLANONLY"],
  });
  expect(stackedValidate.status).toBe(403);
  expect(stackedValidate.body.code).toBe("PROMO_CODE_STACKING_DISABLED");
  const stackedSwitch = await switchToPlanB({
    promo_codes: ["SWITCH10", "PLANONLY"],
  });
  expect(stackedSwitch.status).toBe(403);
  expect(stackedSwitch.body.code).toBe("PROMO_CODE_STACKING_DISABLED");
  expect(await redemptionCount("SWITCH10")).toBe(0);

  // 5) fake only / inapplicable only
  const fake = await switchToPlanB({ promo_codes: ["NOPE"] });
  expect(fake.status).toBe(400);
  expect(fake.body.code).toBe("PROMO_CODE_NOT_FOUND");
  const inapplicable = await switchToPlanB({ promo_codes: ["PLANONLY"] });
  expect(inapplicable.status).toBe(400);
  expect(inapplicable.body.code).toBe("PROMO_CODE_NOT_APPLICABLE_TO_PRODUCT");
  expect(await redemptionCount("PLANONLY")).toBe(0);

  await Project.updateConfig({
    "payments.allowStackingPromoCodes": true,
  });

  // 6) mix valid + bad — all-or-nothing (PLANONLY does not apply to plan-b)
  const mixed = await switchToPlanB({
    promo_codes: ["SWITCH10", "PLANONLY"],
  });
  expect(mixed.status).toBe(400);
  expect(mixed.body.code).toBe("PROMO_CODE_NOT_APPLICABLE_TO_PRODUCT");
  expect(await redemptionCount("SWITCH10")).toBe(0);

  // Blank entries are not coerced to "no codes"
  const blanks = await switchToPlanB({
    promo_codes: ["", "  "],
  });
  expect(blanks.status).toBe(400);
  expect(blanks.body.code).toBe("PROMO_CODE_INVALID");
  expect(await redemptionCount("SWITCH10")).toBe(0);

  // 7) empty list — switch proceeds, no new redemptions
  const empty = await switchToPlanB({
    promo_codes: [],
  });
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({ success: true });
  expect(await redemptionCount("SWITCH10")).toBe(0);
});

it("applies a promo on a test-mode plan switch", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({ code_name: "SWITCH10" }));
  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "plan-a",
      quantity: 1,
    },
  });
  const switched = await niceBackendFetch(`/api/latest/payments/products/user/${userId}/switch`, {
    method: "POST",
    accessType: "client",
    body: {
      from_product_id: "plan-a",
      to_product_id: "plan-b",
      promo_codes: ["SWITCH10"],
    },
  });
  expect(switched.status).toBe(200);
  expect(switched.body).toEqual({ success: true });

  const listed = await niceBackendFetch("/api/latest/internal/payments/promo-codes", {
    accessType: "admin",
  });
  const promo = listed.body.promo_codes.find((row: { code_name: string }) => row.code_name === "SWITCH10");
  expect(promo.num_redemptions).toBe(1);
});

it("creates forever and fixed-duration promo codes", async ({ expect }) => {
  await setupOtpProject();
  const forever = await createPromo(defaultPromoBody({
    code_name: "FOREVER10",
    subscription_behavior: "forever",
  }));
  expect(forever.status).toBe(200);
  expect(forever.body.subscription_behavior).toBe("forever");

  const repeating = await createPromo(defaultPromoBody({
    code_name: "THREE_MONTHS",
    subscription_behavior: "fixed_duration",
    subscription_discount_duration_months: 3,
  }));
  expect(repeating.status).toBe(200);
  expect(repeating.body.subscription_behavior).toBe("fixed_duration");
  expect(repeating.body.subscription_discount_duration_months).toBe(3);
});

it("rejects a promo on a $0 catalog price", async ({ expect }) => {
  await Project.createAndSwitch();
  await Payments.setup();
  await Project.updateConfig({
    payments: {
      testMode: true,
      allowPromoCodes: true,
      products: {
        "free-plan": {
          displayName: "Free Plan",
          customerType: "user",
          serverOnly: false,
          stackable: false,
          prices: {
            monthly: { USD: "0.00", interval: [1, "month"] },
          },
          includedItems: {},
        },
      },
    },
  });
  await createPromo(defaultPromoBody({ code_name: "NOTHING" }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "free-plan", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "monthly",
      promo_codes: ["NOTHING"],
    },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("PROMO_CODE_NOTHING_TO_DISCOUNT");
});

it("rejects a promo that does not apply to the product", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({
    code_name: "PLANONLY",
    applicable_product_ids: ["plan-a"],
  }));
  const { userId } = await Auth.fastSignUp();
  const { code } = await createPurchaseCode({ userId, productId: "otp-product", allowPromoCodes: true });
  const response = await niceBackendFetch("/api/latest/payments/purchases/validate-promo-codes", {
    method: "POST",
    accessType: "client",
    body: {
      full_code: code,
      price_id: "single",
      promo_codes: ["PLANONLY"],
    },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("PROMO_CODE_NOT_APPLICABLE_TO_PRODUCT");
});

it("stores allow_promo_codes on the purchase URL and returns them from validate-code", async ({ expect }) => {
  await setupOtpProject();
  await Project.updateConfig({ "payments.allowStackingPromoCodes": true });
  const { userId } = await Auth.fastSignUp();
  const { response, code } = await createPurchaseCode({
    userId,
    productId: "otp-product",
    allowPromoCodes: true,
    allowStackingPromoCodes: true,
  });
  expect(response.status).toBe(200);
  const validated = await niceBackendFetch("/api/latest/payments/purchases/validate-code", {
    method: "POST",
    accessType: "client",
    body: { full_code: code },
  });
  expect(validated.status).toBe(200);
  expect(validated.body.allow_promo_codes).toBe(true);
  expect(validated.body.allow_stacking_promo_codes).toBe(true);
});

it("rejects create-purchase-url allowPromoCodes when project promo codes are disabled", async ({ expect }) => {
  await setupOtpProject();
  await Project.updateConfig({ "payments.allowPromoCodes": false });
  const { userId } = await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
    method: "POST",
    accessType: "client",
    body: {
      customer_type: "user",
      customer_id: userId,
      product_id: "otp-product",
      allow_promo_codes: true,
    },
  });
  expect(response.status).toBe(403);
  expect(response.body.code).toBe("PROMO_CODES_DISABLED");
});

it("rejects switch promo_codes when project promo codes are disabled", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({ code_name: "SWITCH10" }));
  const { userId } = await Auth.fastSignUp();
  await niceBackendFetch(`/api/latest/payments/products/user/${userId}`, {
    method: "POST",
    accessType: "server",
    body: { product_id: "plan-a", quantity: 1 },
  });
  await Project.updateConfig({ "payments.allowPromoCodes": false });
  const response = await niceBackendFetch(`/api/latest/payments/products/user/${userId}/switch`, {
    method: "POST",
    accessType: "client",
    body: {
      from_product_id: "plan-a",
      to_product_id: "plan-b",
      promo_codes: ["SWITCH10"],
    },
  });
  expect(response.status).toBe(403);
  expect(response.body.code).toBe("PROMO_CODES_DISABLED");
});

it("validates promo codes against a product with a server key", async ({ expect }) => {
  await setupOtpProject();
  await createPromo(defaultPromoBody({ code_name: "TENOFF" }));
  const response = await niceBackendFetch("/api/latest/payments/promo-codes/validate", {
    method: "POST",
    accessType: "server",
    body: {
      product_id: "otp-product",
      price_id: "single",
      promo_codes: ["TENOFF"],
    },
  });
  expect(response.status).toBe(200);
  expect(response.body.applied_code_names).toEqual(["TENOFF"]);
  expect(response.body.net_amount).toBe("45.00");
});
