import type { Json } from "@hexclave/shared/dist/utils/json";

export type PurchaseBody = Record<string, Json>;

export function normalizePurchaseBody(body: PurchaseBody): PurchaseBody {
  const productId = body.product_id ?? body.offer_id;
  const productInline = body.product_inline ?? body.offer_inline;
  const result: Record<string, any> = { ...body, product_id: productId, product_inline: productInline };
  delete result.offer_id;
  delete result.offer_inline;
  return result;
}


import.meta.vitest?.test("normalizePurchaseBody maps offer fields to product equivalents", ({ expect }) => {
  const legacyBody = { offer_id: "legacy_offer", offer_inline: { foo: "bar" } } as Record<string, any>;

  const normalized = normalizePurchaseBody(legacyBody);

  expect(normalized.product_id).toBe("legacy_offer");
  expect(normalized.product_inline).toBe(legacyBody.offer_inline);
  expect(normalized).not.toHaveProperty("offer_id");
  expect(normalized).not.toHaveProperty("offer_inline");
  expect(legacyBody).toEqual({ offer_id: "legacy_offer", offer_inline: { foo: "bar" } });
});
