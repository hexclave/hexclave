import { KnownErrors } from '@hexclave/shared';
import { generateUuid } from '@hexclave/shared/dist/utils/uuids';
import { describe, expect, it } from 'vitest';
import { isSubscriptionCancelable, isSubscriptionInEffect, subscriptionDisplayRank, validatePurchaseSession } from './payments';
import { bulldozerWriteOneTimePurchase, bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { globalPrismaClient } from "@/prisma-client";

// Uses globalPrismaClient which connects to the real dev DB. Payment state is
// written to bulldozer-js (LMDB) via the dual-write functions below, not Postgres.
// customerType: 'custom' avoids needing a real ProjectUser/Team in the DB.
// Each test writes data to Bulldozer stored tables via the dual-write functions
// AND (for subscriptions) to the Prisma Subscription table — validatePurchaseSession
// reads OTP/inline state from the bulldozer ownedProducts view but reads active
// subscriptions straight from Prisma to avoid TimeFold-lag races.
describe.sequential('validatePurchaseSession - purchase guards (real DB)', () => {
  const prisma = globalPrismaClient;
  const testId = Math.random().toString(36).slice(2, 8);
  const tenancyId = generateUuid();
  const customerId = generateUuid();

  const makeProduct = (overrides: Record<string, unknown> = {}) => ({
    displayName: 'Test Product',
    productLineId: null as string | null,
    customerType: 'custom' as const,
    prices: { p1: { USD: '10' } },
    includedItems: {},
    isAddOnTo: false as false | Record<string, true>,
    stackable: false,
    ...overrides,
  });

  const grantOtp = async (id: string, productId: string, product: ReturnType<typeof makeProduct>) => {
    await bulldozerWriteOneTimePurchase({
      id, tenancyId, customerId, customerType: 'CUSTOM',
      productId, priceId: null, product: product as any, quantity: 1,
      stripePaymentIntentId: null, revokedAt: null, refundedAt: null,
      creationSource: 'TEST_MODE', createdAt: new Date(),
    });
  };

  // Writes ONLY to Prisma, not bulldozer — simulates the lag window where the
  // dual-write has committed to Prisma but the bulldozer ownedProducts view
  // hasn't propagated yet. Used to verify validatePurchaseSession's
  // Prisma-backed same-product guards still catch the duplicate.
  const grantOtpPrismaOnly = async (id: string, productId: string, opts: { revokedAt?: Date | null, refundedAt?: Date | null } = {}) => {
    await prisma.oneTimePurchase.create({
      data: {
        id, tenancyId, customerId, customerType: 'CUSTOM',
        productId, priceId: null, product: {} as any, quantity: 1,
        stripePaymentIntentId: null,
        revokedAt: opts.revokedAt ?? null,
        refundedAt: opts.refundedAt ?? null,
        creationSource: 'TEST_MODE',
      },
    });
  };

  const grantSubPrismaOnly = async (id: string, productId: string, productLineId: string | null = null) => {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 86400000);
    await prisma.subscription.create({
      data: {
        id, tenancyId, customerId, customerType: 'CUSTOM',
        productId, priceId: null,
        product: { productLineId } as any,
        quantity: 1,
        stripeSubscriptionId: `stripe-prisma-only-${id}`, status: 'active',
        currentPeriodStart: now, currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false, creationSource: 'TEST_MODE',
      },
    });
  };

  const grantSub = async (id: string, productId: string, product: ReturnType<typeof makeProduct>) => {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 86400000);
    await prisma.subscription.create({
      data: {
        id, tenancyId, customerId, customerType: 'CUSTOM',
        productId, priceId: null, product: product as any, quantity: 1,
        stripeSubscriptionId: `stripe-${id}`, status: 'active',
        currentPeriodStart: now, currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false, creationSource: 'TEST_MODE',
      },
    });
    await bulldozerWriteSubscription({
      id, tenancyId, customerId, customerType: 'CUSTOM',
      productId, priceId: null, product: product as any, quantity: 1,
      stripeSubscriptionId: `stripe-${id}`, status: 'active',
      currentPeriodStart: now, currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false, canceledAt: null, endedAt: null, refundedAt: null, productRevokedAt: null,
      creationSource: 'TEST_MODE', createdAt: now,
    });
  };

  const callValidate = (product: ReturnType<typeof makeProduct>, overrides: Record<string, unknown> = {}) =>
    validatePurchaseSession({
      prisma: prisma as any,
      tenancyId,
      customerType: 'custom',
      customerId,
      product: product as any,
      productId: `prod-new-${testId}`,
      priceId: undefined,
      quantity: 1,
      ...overrides,
    });

  it('blocks non-stackable product if customer already owns it', async () => {
    const prodId = `prod-dup-${testId}`;
    await grantOtp(`otp-dup-${testId}`, prodId, makeProduct());
    await expect(callValidate(makeProduct(), { productId: prodId })).rejects.toThrowError(/already owns/);
  });

  it('allows stackable product even if customer already owns it', async () => {
    const prodId = `prod-stack-${testId}`;
    await grantOtp(`otp-stack-${testId}`, prodId, makeProduct({ stackable: true }));
    const res = await callValidate(makeProduct({ stackable: true }), { productId: prodId });
    expect(res.selectedPrice).toBeDefined();
  });

  it('blocks non-stackable quantity > 1', async () => {
    await expect(callValidate(makeProduct(), { quantity: 3 }))
      .rejects.toThrowError('not stackable');
  });

  it('blocks purchase when OTP exists in same product line (no sub to cancel)', async () => {
    const lineId = `line-block-${testId}`;
    await grantOtp(`otp-line-${testId}`, `prod-in-line-${testId}`, makeProduct({ productLineId: lineId }));
    await expect(callValidate(makeProduct({ productLineId: lineId }), { productId: `prod-other-${testId}` }))
      .rejects.toThrowError('one-time purchase in this product line');
  });

  it('allows purchase when existing product is in different product line', async () => {
    const res = await callValidate(
      makeProduct({ productLineId: `line-different-${testId}` }),
      { productId: `prod-diff-${testId}` },
    );
    expect(res.conflictingSubscriptions).toHaveLength(0);
  });

  it('blocks duplicate non-stackable OTP via Prisma when bulldozer lags (OTP guard)', async () => {
    const prodId = `prod-otp-prisma-${testId}`;
    await grantOtpPrismaOnly(generateUuid(), prodId);
    await expect(callValidate(makeProduct(), { productId: prodId })).rejects.toThrowError(/already owns/);
  });

  it('allows repurchase of a refunded OTP (OTP guard ignores refundedAt rows)', async () => {
    const prodId = `prod-otp-refunded-${testId}`;
    await grantOtpPrismaOnly(generateUuid(), prodId, { refundedAt: new Date() });
    const res = await callValidate(makeProduct(), { productId: prodId });
    expect(res.selectedPrice).toBeDefined();
  });

  it('allows repurchase of a revoked OTP (OTP guard ignores revokedAt rows)', async () => {
    const prodId = `prod-otp-revoked-${testId}`;
    await grantOtpPrismaOnly(generateUuid(), prodId, { revokedAt: new Date() });
    const res = await callValidate(makeProduct(), { productId: prodId });
    expect(res.selectedPrice).toBeDefined();
  });

  it('blocks duplicate non-stackable subscription via Prisma even when product has no productLineId (sub guard hoist)', async () => {
    const prodId = `prod-sub-noline-${testId}`;
    await grantSubPrismaOnly(generateUuid(), prodId, null);
    await expect(callValidate(makeProduct({ productLineId: null }), { productId: prodId })).rejects.toThrowError(/already owns/);
  });

  it('allows different product purchase even when an unrelated active sub exists (sub guard scoped to same productId)', async () => {
    const ownedProdId = `prod-sub-other-${testId}`;
    const newProdId = `prod-sub-fresh-${testId}`;
    await grantSubPrismaOnly(generateUuid(), ownedProdId, null);
    const res = await callValidate(makeProduct({ productLineId: null }), { productId: newProdId });
    expect(res.selectedPrice).toBeDefined();
  });

  it('finds conflicting subscription in same product line', async () => {
    const lineId = `line-conflict-${testId}`;
    const subId = generateUuid();
    await grantSub(subId, `prod-sub-${testId}`, makeProduct({ productLineId: lineId }));
    const res = await callValidate(
      makeProduct({ productLineId: lineId }),
      { productId: `prod-replace-${testId}` },
    );
    expect(res.conflictingSubscriptions).toHaveLength(1);
    expect(res.conflictingSubscriptions[0].id).toBe(subId);
  });

  it('blocks add-on if base product not owned', async () => {
    await expect(callValidate(makeProduct({ isAddOnTo: { [`base-${testId}`]: true } })))
      .rejects.toThrowError('add-on');
  });

  it('allows add-on if base product is owned', async () => {
    const baseId = `base-addon-${testId}`;
    await grantOtp(`otp-base-${testId}`, baseId, makeProduct());
    const res = await callValidate(makeProduct({ isAddOnTo: { [baseId]: true } }));
    expect(res.selectedPrice).toBeDefined();
  });

  it('allows add-on in same product line as its base product', async () => {
    const lineId = `line-addon-${testId}`;
    const baseId = `base-sameline-${testId}`;
    await grantOtp(`otp-sameline-${testId}`, baseId, makeProduct({ productLineId: lineId }));
    const res = await callValidate(
      makeProduct({ productLineId: lineId, isAddOnTo: { [baseId]: true } }),
      { productId: `addon-sameline-${testId}` },
    );
    expect(res.selectedPrice).toBeDefined();
    expect(res.conflictingSubscriptions).toHaveLength(0);
  });

  // TODO: reconsider coupling — product-line blocking infers OTP vs subscription
  // ownership. OTPs can be refunded, so "blocked because OTP" is debatable.

  it('resolves first price when no priceId given', async () => {
    const res = await callValidate(makeProduct({ prices: { p1: { USD: '10' }, p2: { USD: '20' } } }));
    expect(res.selectedPrice).toBeDefined();
    expect((res.selectedPrice as any).USD).toBe('10');
  });

  it('resolves specific priceId when given', async () => {
    const res = await callValidate(
      makeProduct({ prices: { p1: { USD: '10' }, p2: { USD: '20' } } }),
      { priceId: 'p2' },
    );
    expect(res.selectedPrice).toBeDefined();
    expect((res.selectedPrice as any).USD).toBe('20');
  });

  it('rejects invalid priceId', async () => {
    await expect(callValidate(
      makeProduct({ prices: { p1: { USD: '10' } } }),
      { priceId: 'nonexistent' },
    )).rejects.toThrowError('Price not found');
  });

  it('treats a canceled-at-period-end sub in the same line as a replaceable conflict, not an OTP', async () => {
    const lineId = `line-winddown-${testId}`;
    const subId = generateUuid();
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 86400000);
    const product = makeProduct({ productLineId: lineId });
    await prisma.subscription.create({
      data: {
        id: subId, tenancyId, customerId, customerType: 'CUSTOM',
        productId: `prod-winddown-${testId}`, priceId: null, product: product as any, quantity: 1,
        stripeSubscriptionId: null, status: 'canceled',
        currentPeriodStart: now, currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true, canceledAt: now, endedAt: periodEnd,
        creationSource: 'TEST_MODE',
      },
    });
    await bulldozerWriteSubscription({
      id: subId, tenancyId, customerId, customerType: 'CUSTOM',
      productId: `prod-winddown-${testId}`, priceId: null, product: product as any, quantity: 1,
      stripeSubscriptionId: null, status: 'canceled',
      currentPeriodStart: now, currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true, canceledAt: now, endedAt: periodEnd, refundedAt: null, productRevokedAt: null,
      creationSource: 'TEST_MODE', createdAt: now,
    });
    const res = await callValidate(product, { productId: `prod-after-winddown-${testId}` });
    expect(res.conflictingSubscriptions.map(s => s.id)).toContain(subId);
  });
});

describe('isSubscriptionInEffect', () => {
  const nowMillis = 1_800_000_000_000;

  it('treats endedAt=null as in effect regardless of status', () => {
    expect(isSubscriptionInEffect({ endedAtMillis: null }, nowMillis)).toBe(true);
    expect(isSubscriptionInEffect({ endedAt: null }, nowMillis)).toBe(true);
  });

  it('is in effect strictly before endedAt, not at or after it', () => {
    expect(isSubscriptionInEffect({ endedAtMillis: nowMillis + 1 }, nowMillis)).toBe(true);
    expect(isSubscriptionInEffect({ endedAtMillis: nowMillis }, nowMillis)).toBe(false);
    expect(isSubscriptionInEffect({ endedAtMillis: nowMillis - 1 }, nowMillis)).toBe(false);
  });

  it('accepts the Prisma Date shape', () => {
    expect(isSubscriptionInEffect({ endedAt: new Date(nowMillis + 1) }, nowMillis)).toBe(true);
    expect(isSubscriptionInEffect({ endedAt: new Date(nowMillis) }, nowMillis)).toBe(false);
  });
});

describe('isSubscriptionCancelable', () => {
  it('is true only for active/trialing subs not already winding down', () => {
    expect(isSubscriptionCancelable({ status: 'active', cancelAtPeriodEnd: false })).toBe(true);
    expect(isSubscriptionCancelable({ status: 'trialing', cancelAtPeriodEnd: false })).toBe(true);
    expect(isSubscriptionCancelable({ status: 'active', cancelAtPeriodEnd: true })).toBe(false);
    expect(isSubscriptionCancelable({ status: 'canceled', cancelAtPeriodEnd: true })).toBe(false);
    expect(isSubscriptionCancelable({ status: 'past_due', cancelAtPeriodEnd: false })).toBe(false);
  });
});

describe('subscriptionDisplayRank', () => {
  it('ranks cancelable above pending-cancel Stripe subs above wound-down subs', () => {
    const cancelable = { status: 'active', cancelAtPeriodEnd: false };
    // Pending-cancel Stripe subs stay `active` — the tier an active-only
    // preference gets wrong
    const stripePendingCancel = { status: 'active', cancelAtPeriodEnd: true };
    const localWindingDown = { status: 'canceled', cancelAtPeriodEnd: true };
    expect(subscriptionDisplayRank(cancelable)).toBeGreaterThan(subscriptionDisplayRank(stripePendingCancel));
    expect(subscriptionDisplayRank(stripePendingCancel)).toBeGreaterThan(subscriptionDisplayRank(localWindingDown));
  });
});

