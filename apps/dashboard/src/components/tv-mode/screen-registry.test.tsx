/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getTvFixtureSnapshot } from "@/lib/tv-mode/fixtures";
import { TvEmailHealthScreenSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import styles from "./screen-layout.module.css";
import { formatTvExactUsd, formatTvSignedPercent, getTvAxisLabelIndices, renderTvScreen } from "./screen-registry";

function readTvMetrics(doc: Document): Map<string | null | undefined, string | null | undefined> {
  return new Map(Array.from(doc.querySelectorAll("[data-hero]"), metric => [
    metric.querySelector("p")?.textContent,
    metric.querySelector("p:nth-child(2)")?.textContent,
  ]));
}

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

  it("keeps send volume visible while using status typography for insufficient outcomes", () => {
    const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", "insufficient-data");
    const email = snapshot?.screens.find((screen) => screen.id === "email-health");
    if (email?.data == null) throw new Error("Email fixture missing");
    expect(TvEmailHealthScreenSchema.isValidSync(email, { strict: true })).toBe(true);
    const html = renderToStaticMarkup(renderTvScreen(email));
    expect(html).toContain('data-hero="true" data-text-value="false"');
    expect(html).toContain('data-hero="false" data-text-value="true"');
    expect(html).toContain("Insufficient data");
    expect(html).not.toContain("Delivery remained above 99%");
    for (const label of ["Delivered", "Bounced", "Errors", "In progress"]) expect(html).toContain(label);
  });

  it.each(["email-no-receipts", "insufficient-data", "default"] as const)("shows completed attempts independently of delivery evidence (%s)", (variant) => {
    const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", variant);
    const email = snapshot?.screens.find((screen) => screen.id === "email-health");
    if (email?.data == null) throw new Error("Email fixture missing");
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(renderTvScreen(email)), "text/html");
    const metrics = readTvMetrics(doc);
    expect(metrics.get(variant === "email-no-receipts" ? "Emails sent · 7d" : "Completed send attempts · 7d")).toBe(email.data.sent.toLocaleString());
    expect(metrics.get("Delivery rate · 7d")).toBe(email.data.deliveryRatePercent == null
      ? variant === "email-no-receipts" ? "No delivery data" : "Insufficient data"
      : `${email.data.deliveryRatePercent}%`);
    expect(doc.body.textContent).toContain(variant === "email-no-receipts" ? "Accepted by mail server" : "Includes successful sends and failed attempts");
    expect(doc.body.textContent).toContain(variant === "email-no-receipts" ? "Sent and failed by send date" : "excludes unconfirmed sends");
    if (variant === "email-no-receipts") {
      expect(Object.fromEntries(metrics)).toEqual({
        "Bounced": "0",
        "Emails sent · 7d": "250",
        "Delivered": "0",
        "Delivery rate · 7d": "No delivery data",
        "Errors": "0",
        "In progress": "0",
      });
      const chart = doc.querySelector('[aria-label="Sent, Error, In progress by day"]');
      expect(chart).not.toBeNull();
      expect(Array.from(chart?.querySelectorAll("span[style]") ?? []).some(segment =>
        segment.getAttribute("style")?.includes("height:100%")
      )).toBe(true);
      expect(doc.body.textContent).toContain("Send activity recorded; delivery receipts unavailable");
      expect(doc.body.textContent).not.toContain("Delivery remained above 99%");
    }
  });

  it("does not claim server acceptance when a window has no successful sends", () => {
    const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", "email-no-receipts");
    const email = snapshot?.screens.find((screen) => screen.id === "email-health");
    if (email?.data == null) throw new Error("Email fixture missing");
    email.data.sendActivity = {
      sent: 0,
      failed: 3,
      trend: [{ label: "Sep 22", primary: 0, secondary: 3, tertiary: 0 }],
    };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(renderTvScreen(email)), "text/html");
    const metrics = readTvMetrics(doc);
    expect(metrics.get("Emails sent · 7d")).toBe("0");
    expect(metrics.get("Errors")).toBe("3");
    expect(doc.body.textContent).toContain("No successful sends in this window");
    expect(doc.body.textContent).not.toContain("Accepted by mail server");
  });

  it("labels monitored sources as categories even when a source has no receipts", () => {
    const snapshot = getTvFixtureSnapshot("layout-test", "company-pulse", "email-no-receipts");
    const live = snapshot?.screens.find((screen) => screen.id === "live-pulse");
    if (live?.data == null) throw new Error("Live Pulse fixture missing");
    const html = renderToStaticMarkup(renderTvScreen(live));
    expect(html).toContain("Source categories");
    expect(html).not.toContain("Reporting now");
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
