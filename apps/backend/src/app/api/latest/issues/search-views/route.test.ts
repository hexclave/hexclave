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

import { GET, POST } from "./route";
import { DELETE, PUT } from "./[view_id]/route";

describe("saved issue search view management routes", () => {
  it("requires server-or-admin authentication for listing", async () => {
    const overload = [...GET.overloads.values()].at(0);
    if (overload === undefined) throw new Error("saved view GET route did not register");

    await expect(overload.request.validate({
      auth: { type: "client", tenancy: null },
      query: {},
    }, { context: { noUnknownPathPrefixes: ["query"] } })).rejects.toThrow();
  });

  it("requires server-or-admin authentication for creation", async () => {
    const overload = [...POST.overloads.values()].at(0);
    if (overload === undefined) throw new Error("saved view POST route did not register");

    await expect(overload.request.validate({
      auth: { type: "client", tenancy: null },
      body: {},
    }, { context: { noUnknownPathPrefixes: ["body"] } })).rejects.toThrow();
  });

  it("rejects unknown list query parameters instead of ignoring them", async () => {
    const overload = [...GET.overloads.values()].at(0);
    if (overload === undefined) throw new Error("saved view GET route did not register");

    await expect(overload.request.validate({
      auth: { type: "server", tenancy: {} },
      query: { cursor: "not-supported" },
    }, { context: { noUnknownPathPrefixes: ["query"] } })).rejects.toThrow();
  });

  it("rejects caller-supplied scope fields at the management boundary", async () => {
    const overload = [...POST.overloads.values()].at(0);
    if (overload === undefined) throw new Error("saved view POST route did not register");

    await expect(overload.request.validate({
      auth: { type: "server", tenancy: {} },
      body: {
        name: "Errors",
        visibility: "project",
        query: { version: 1, filters: { record: "issue" } },
        project_id: "other-project",
      },
    }, { context: { noUnknownPathPrefixes: ["body"] } })).rejects.toThrow();
  });

  it("keeps reads machine-scoped while exposing mutations through the user-or-admin auth schema", async () => {
    const put = [...PUT.overloads.values()].at(0);
    const del = [...DELETE.overloads.values()].at(0);
    if (put === undefined || del === undefined) throw new Error("saved view mutation routes did not register");

    const mutationRequest = {
      auth: { type: "client", tenancy: {} },
      params: { view_id: "11111111-1111-4111-8111-111111111111" },
      body: {
        name: "Errors",
        visibility: "project",
        query: { version: 1, filters: { record: "issue" } },
      },
    };
    await expect(put.request.validate(mutationRequest, { context: { noUnknownPathPrefixes: ["body", "params"] } })).resolves.toBeDefined();
    await expect(del.request.validate({
      auth: { type: "client", tenancy: {} },
      params: mutationRequest.params,
    }, { context: { noUnknownPathPrefixes: ["params"] } })).resolves.toBeDefined();
  });
});
