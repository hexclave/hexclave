export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(4)}`;
}

/**
 * Signed money for deltas such as cache savings, where a negative value means caching cost money.
 * The sign sits before the currency symbol (`−$0.0040`, never `$-0.0040`), matching the usage grid.
 */
export function formatSignedUsd(value: number): string {
  return `${value >= 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}
