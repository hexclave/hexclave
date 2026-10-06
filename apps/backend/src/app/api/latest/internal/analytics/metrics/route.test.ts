import { describe, expect, it, vi } from "vitest";

vi.mock("@/route-handlers/smart-route-handler", () => ({
  createSmartRouteHandler: (...args: readonly unknown[]) => {
    const definition = args.at(-1);
    if (typeof definition !== "object" || definition === null) throw new Error("route definition is missing");
    return { overloads: new Map([[undefined, definition]]) };
  },
}));

import { POST } from "./route";

const route = [...POST.overloads.values()].at(0);
if (route === undefined) throw new Error("metrics query route did not register");

const enabledTenancy = {
  config: { apps: { installed: { observability: { enabled: true } } } },
  project: { id: "project-1" },
  branchId: "main",
};

describe("internal native metrics query route", () => {
  it("requires admin authentication and an allowlisted range", async () => {
    await expect(route.request.validate({ auth: { type: "server", tenancy: {} }, body: { hours: 24 } }, { context: {} })).rejects.toThrow();
    await expect(route.request.validate({ auth: { type: "admin", tenancy: enabledTenancy }, body: { hours: 2 } }, { context: {} })).rejects.toThrow();
    await expect(route.request.validate({ auth: { type: "admin", tenancy: enabledTenancy }, body: { hours: 24 } }, { context: {} })).resolves.toBeDefined();
  });
});
