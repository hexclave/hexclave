import { describe, expect, it } from "vitest";
import { formatTvExactUsd, formatTvSignedPercent } from "./screen-registry";

describe("formatTvExactUsd", () => {
  function formatExpectedUsd(cents: number, fractionDigits: number): string {
    return Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(cents / 100);
  }

  it("keeps cents for amounts that are not whole dollars", () => {
    expect(formatTvExactUsd(123456)).toBe(formatExpectedUsd(123456, 2));
    expect(formatTvExactUsd(1)).toBe(formatExpectedUsd(1, 2));
  });

  it("stays compact for whole-dollar amounts", () => {
    expect(formatTvExactUsd(123400)).toBe(formatExpectedUsd(123400, 0));
    expect(formatTvExactUsd(0)).toBe(formatExpectedUsd(0, 0));
  });
});

describe("formatTvSignedPercent", () => {
  it("points the arrow in the direction of the change", () => {
    expect(formatTvSignedPercent(18.3)).toBe("↑ 18.3%");
    expect(formatTvSignedPercent(-12)).toBe("↓ 12%");
  });

  it("omits the arrow when there is no change", () => {
    expect(formatTvSignedPercent(0)).toBe("0%");
  });
});
