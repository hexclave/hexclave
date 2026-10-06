import { describe, expect, it, vi } from "vitest";

vi.mock("@/route-handlers/smart-route-handler", () => ({
  createSmartRouteHandler: (...args: readonly unknown[]) => {
    const definition = args.at(-1);
    if (typeof definition !== "object" || definition === null) throw new Error("route definition is missing");
    return { overloads: new Map([[undefined, definition]]) };
  },
}));
vi.mock("@/prisma-client", () => ({
  getPrismaClientForTenancy: vi.fn(),
}));
vi.mock("@/lib/issues/public-search/query", () => ({
  searchPublicRecords: vi.fn(),
}));

import { GET } from "./route";

describe("public observability search route", () => {
  it("requires server-or-admin authentication before the handler can run", async () => {
    const overload = [...GET.overloads.values()].at(0);
    if (overload === undefined) throw new Error("Public search route did not register its GET overload");

    await expect(overload.request.validate({
      auth: { type: "client", tenancy: null },
      query: {},
    }, { context: { noUnknownPathPrefixes: ["query"] } })).rejects.toThrow();
  });

  it("rejects unsupported query dimensions instead of ignoring them", async () => {
    const overload = [...GET.overloads.values()].at(0);
    if (overload === undefined) throw new Error("Public search route did not register its GET overload");

    await expect(overload.request.validate({
      auth: { type: "server", tenancy: {} },
      query: { unsupported_dimension: "value" },
    }, { context: { noUnknownPathPrefixes: ["query"] } })).rejects.toThrow();
  });
});
