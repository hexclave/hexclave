import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getTvFixtureSnapshot } from "@/lib/tv-mode/fixtures";
import { TvEmailHealthScreenSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import styles from "./screen-layout.module.css";
import { formatTvExactUsd, formatTvSignedPercent, getTvAxisLabelIndices, renderTvScreen } from "./screen-registry";

describe("TV layout content", () => {
  it("uses the shared grid only for data screens, not terminal source states", () => {
    for (const variant of ["default", "empty", "unavailable", "partial-failure"] as const) {
      const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", variant);
      if (snapshot == null) throw new Error("Layout fixture missing");
      for (const screen of snapshot.screens) {
        const html = renderToStaticMarkup(renderTvScreen(screen));
        expect(html.includes(styles.screenGrid)).toBe(screen.data != null);
        expect(html).not.toContain("grid-cols-[");
      }
    }
  });

  it("bounds axis labels without dropping either endpoint", () => {
    expect(getTvAxisLabelIndices(0)).toEqual([]);
    expect(getTvAxisLabelIndices(1)).toEqual([0]);
    expect(getTvAxisLabelIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(getTvAxisLabelIndices(24)).toEqual([0, 4, 8, 12, 15, 19, 23]);
  });

  it("uses status typography for insufficient email outcomes and retains submetrics", () => {
    const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", "insufficient-data");
    const email = snapshot?.screens.find((screen) => screen.id === "email-health");
    if (email?.data == null) throw new Error("Email fixture missing");
    expect(TvEmailHealthScreenSchema.isValidSync(email, { strict: true })).toBe(true);
    const html = renderToStaticMarkup(renderTvScreen(email));
    expect(html).toContain('data-hero="true" data-text-value="true"');
    expect(html).toContain("Insufficient data");
    expect(html).not.toContain("Delivery remained above 99%");
    for (const label of ["Delivered", "Bounced", "Errors", "In progress"]) expect(html).toContain(label);
  });
});

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
