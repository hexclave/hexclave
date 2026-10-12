import { createHash } from "node:crypto";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";

export const REFUND_TXN_PREFIX = "refund:";

/**
 * The set of source-transaction id prefixes that the refund flow can target.
 * Pinned here so the LIKE-pattern safety invariant in `readPriorRefundSummary`
 * and the listing route is testable: none of these may contain LIKE
 * metacharacters (% / _ / \). If a future source format is added, the test
 * below will fail loud rather than silently producing false-positive matches.
 */
export const REFUND_SOURCE_TXN_PREFIXES = [
  "sub-start:",
  "sub-renewal:",
  "otp:",
] as const;

export type RefundEndActionFingerprint = "now" | "at-period-end" | "none";

/**
 * Parse a refund txnId of shape `refund:<sourceTxnId>:<suffix>`.
 *
 * The trailing `<suffix>` used to be a random UUID; new refunds use a
 * deterministic sha256 hex prefix (see `makeRefundTxnId`). The field is still
 * named `uuid` so callers (and the duplicate parser in bulldozer-js) stay in
 * sync without a rename — treat it as an opaque suffix.
 *
 * The sourceTxnId itself may contain colons (e.g. `sub-start:abc`), so we
 * strip the leading `refund:` and the trailing `:<suffix>`. Returns null for
 * non-refund ids.
 */
export function parseRefundTxnId(txnId: string): { sourceTxnId: string, uuid: string } | null {
  if (!txnId.startsWith(REFUND_TXN_PREFIX)) return null;
  const rest = txnId.slice(REFUND_TXN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const sourceTxnId = rest.slice(0, lastColon);
  const uuid = rest.slice(lastColon + 1);
  if (sourceTxnId.length === 0 || uuid.length === 0) return null;
  return { sourceTxnId, uuid };
}

/**
 * Stripe-unit amounts in the fingerprint must be whole non-negative cents.
 *
 * Callers are responsible for converting dollar strings via
 * `moneyAmountToStripeUnits` *before* invoking `makeRefundTxnId`. Hitting this
 * with a float / NaN / negative is a platform bug (HexclaveAssertionError →
 * sanitized 500), not a client SchemaError — never pass raw `amount_usd`.
 */
function requireNonNegativeStripeUnits(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HexclaveAssertionError(
      `${label} must be a non-negative safe integer (stripe units / cents) before makeRefundTxnId; got ${JSON.stringify(value)}. Callers must run moneyAmountToStripeUnits first.`,
      { label, value },
    );
  }
  return value;
}

/**
 * Build a retry-stable refund txn id: `refund:<sourceTxnId>:<hash>`.
 *
 * The hash fingerprints the same inputs a same-payload retry would see
 * (including Bulldozer's prior refunded amount, which does not advance until
 * the Bulldozer write succeeds). That way a Prisma-ok / Bulldozer-fail retry
 * reuses the same `txnId` and the Prisma upsert + Bulldozer setRow converge.
 *
 * Intentional second refunds (different amount, or same amount after prior
 * advanced) get a different id. `endAction` is required so two amount=0
 * lifecycle-only refunds (schedule cancel vs end now) do not collide.
 *
 * Historical rows keep UUID suffixes; this function only affects new writes.
 *
 * `amountStripeUnits` / `priorRefundedStripeUnits` must already be integer
 * cents (e.g. `"2.50"` → 250). The refund route converts via
 * `moneyAmountToStripeUnits` at the handler entrypoint; prior is summed the
 * same way in bulldozer's `readPriorRefundSummary`.
 */
export function makeRefundTxnId(
  tenancyId: string,
  sourceTxnId: string,
  amountStripeUnits: number,
  priorRefundedStripeUnits: number,
  endAction: RefundEndActionFingerprint,
): string {
  const amount = requireNonNegativeStripeUnits(amountStripeUnits, "amountStripeUnits");
  const prior = requireNonNegativeStripeUnits(priorRefundedStripeUnits, "priorRefundedStripeUnits");
  // Integers stringify unambiguously ("250", never "2.50" or "2.5e2").
  const fingerprint = `${tenancyId}:${sourceTxnId}:${amount}:${prior}:${endAction}`;
  const suffix = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  return `${REFUND_TXN_PREFIX}${sourceTxnId}:${suffix}`;
}

import.meta.vitest?.describe("parseRefundTxnId", (test) => {
  test("parses a refund txn id with a colon-containing source", ({ expect }) => {
    const parsed = parseRefundTxnId("refund:sub-start:abc-123:550e8400-e29b-41d4-a716-446655440000");
    expect(parsed).toEqual({
      sourceTxnId: "sub-start:abc-123",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
  });
  test("parses an OTP refund txn id", ({ expect }) => {
    const parsed = parseRefundTxnId("refund:otp:abc:550e8400-e29b-41d4-a716-446655440000");
    expect(parsed).toEqual({
      sourceTxnId: "otp:abc",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
  });
  test("parses a deterministic hash suffix", ({ expect }) => {
    const id = makeRefundTxnId("t1", "otp:abc", 100, 0, "none");
    const parsed = parseRefundTxnId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.sourceTxnId).toBe("otp:abc");
    expect(parsed?.uuid).toMatch(/^[0-9a-f]{32}$/);
  });
  test("returns null for non-refund txn ids", ({ expect }) => {
    expect(parseRefundTxnId("sub-start:abc")).toBeNull();
    expect(parseRefundTxnId("otp:abc")).toBeNull();
  });
});

import.meta.vitest?.describe("makeRefundTxnId", (test) => {
  test("same fingerprint yields the same id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .toBe(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"));
  });

  test("shape is refund:<sourceTxnId>:<32-hex>", ({ expect }) => {
    const id = makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none");
    expect(id).toMatch(/^refund:sub-start:sub-abc:[0-9a-f]{32}$/);
  });

  test("dollar cents like 2.50 / 2.39 are distinct once converted to stripe units", ({ expect }) => {
    // Route converts "2.50" → 250 and "2.39" → 239 before calling us.
    const id250 = makeRefundTxnId("t1", "otp:p1", 250, 0, "none");
    const id239 = makeRefundTxnId("t1", "otp:p1", 239, 0, "none");
    expect(id250).not.toBe(id239);
    expect(id250).toBe(makeRefundTxnId("t1", "otp:p1", 250, 0, "none"));
  });

  test("rejects non-integer stripe units as HexclaveAssertionError (platform bug → 500)", ({ expect }) => {
    expect(() => makeRefundTxnId("t1", "otp:p1", 2.5, 0, "none")).toThrow(HexclaveAssertionError);
    expect(() => makeRefundTxnId("t1", "otp:p1", 250, 1.5, "none")).toThrow(HexclaveAssertionError);
    expect(() => makeRefundTxnId("t1", "otp:p1", NaN, 0, "none")).toThrow(HexclaveAssertionError);
    expect(() => makeRefundTxnId("t1", "otp:p1", -1, 0, "none")).toThrow(HexclaveAssertionError);
  });

  test("moneyAmountToStripeUnits output is always accepted by makeRefundTxnId (call-site invariant)", ({ expect }) => {
    // Attests the refund-route contract: convert amount_usd first, then fingerprint.
    // If this fails, the handler is passing dollars/floats into makeRefundTxnId.
    const USD = SUPPORTED_CURRENCIES.find((c) => c.code === "USD") ?? throwErr("USD missing");
    for (const amountUsd of ["2.39", "2.50", "2.5", "0", "0.01", "50.00"] as MoneyAmount[]) {
      const cents = moneyAmountToStripeUnits(amountUsd, USD);
      expect(Number.isSafeInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThanOrEqual(0);
      expect(() => makeRefundTxnId("t1", "otp:p1", cents, 0, "none")).not.toThrow();
    }
    expect(moneyAmountToStripeUnits("2.39" as MoneyAmount, USD)).toBe(239);
    expect(moneyAmountToStripeUnits("2.50" as MoneyAmount, USD)).toBe(250);
    expect(moneyAmountToStripeUnits("2.5" as MoneyAmount, USD)).toBe(250);
  });

  test("different prior yields a different id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .not.toBe(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 100, "none"));
  });

  test("different amount yields a different id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .not.toBe(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 501, 0, "none"));
  });

  test("different endAction yields a different id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .not.toBe(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "now"));
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "now"))
      .not.toBe(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "at-period-end"));
  });

  test("different tenancy yields a different id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .not.toBe(makeRefundTxnId("tenancy-2", "sub-start:sub-abc", 500, 0, "none"));
  });

  test("different source yields a different id", ({ expect }) => {
    expect(makeRefundTxnId("tenancy-1", "sub-start:sub-abc", 500, 0, "none"))
      .not.toBe(makeRefundTxnId("tenancy-1", "otp:purchase-1", 500, 0, "none"));
  });
});

import.meta.vitest?.describe("REFUND_SOURCE_TXN_PREFIXES", (test) => {
  test("contains no SQL LIKE metacharacters (the LIKE-safety invariant for readPriorRefundSummary)", ({ expect }) => {
    for (const prefix of REFUND_SOURCE_TXN_PREFIXES) {
      expect(prefix).not.toMatch(/[%_\\]/);
    }
  });
});
