import { branchConfigSchema, getConfigOverrideErrors, getIncompleteConfigWarnings } from "@hexclave/shared/dist/config/schema";
import { describe, expect, it } from "vitest";
import { buildDummyNavigationJourney, buildDummyPaymentsSetup } from "./seed-dummy-data";

describe("dummy payments seed config", () => {
  it("is valid branch payments config", async () => {
    const { paymentsBranchOverride } = buildDummyPaymentsSetup();
    const branchConfigOverride = { payments: paymentsBranchOverride };

    expect(await getConfigOverrideErrors(branchConfigSchema, branchConfigOverride)).toMatchInlineSnapshot(`
      {
        "data": null,
        "status": "ok",
      }
    `);
    expect(await getIncompleteConfigWarnings(branchConfigSchema, branchConfigOverride)).toMatchInlineSnapshot(`
      {
        "data": null,
        "status": "ok",
      }
    `);
  });
});

describe("dummy navigation seed data", () => {
  it("builds a deterministic dense graph from scrubbed routes", () => {
    const journeys = Array.from({ length: 21 }, (_, index) => buildDummyNavigationJourney(index, 0));
    const routes = new Set(journeys.flat());
    const edges = new Set(journeys.flatMap((journey) => journey.slice(1).map((route, index) => `${journey[index]} -> ${route}`)));

    expect(routes.size).toBeGreaterThanOrEqual(50);
    expect(edges.size).toBeGreaterThanOrEqual(60);
    expect(journeys[0]).toEqual(['/', '/product', '/product/analytics', '/pricing', '/sign-up']);
    expect(journeys[20]).toEqual(journeys[0]);
    expect([...routes].every((route) => !route.includes('stack-auth.com') && !route.includes('hexclave.com'))).toBe(true);
  });
});
