/**
 * Helpers for resolving a single price from a product snapshot. Originally
 * this file held a family of `build*Transaction` constructors that the old
 * refund/listing endpoints used to hand-roll API `Transaction` shapes from
 * Prisma rows. The three-knob refund rework moved both flows onto the
 * bulldozer-derived listing path, leaving only `resolveSelectedPriceFromProduct`
 * still in use (called by `refund/route.tsx` to compute the USD cap).
 */

type SelectedPriceMetadata = {
  interval?: unknown,
};

type SelectedPrice = Record<string, unknown> & SelectedPriceMetadata;

type ProductPriceEntryExtras = {
  serverOnly?: unknown,
  freeTrial?: unknown,
};

type ProductPriceEntry = SelectedPrice & ProductPriceEntryExtras;

export type ProductWithPrices = {
  displayName?: string,
  prices?: Record<string, ProductPriceEntry>,
} | null | undefined;

export function resolveSelectedPriceFromProduct(product: ProductWithPrices, priceId?: string | null): SelectedPrice | null {
  if (!product) return null;
  if (!priceId) return null;
  const prices = product.prices;
  if (!prices) return null;
  if (!Object.hasOwn(prices, priceId)) return null;
  const selected = prices[priceId];
  const { serverOnly: _serverOnly, freeTrial: _freeTrial, ...rest } = selected;
  return rest;
}
