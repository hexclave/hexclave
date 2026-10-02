import { describe, expect, it, vi } from "vitest";

vi.mock("@/route-handlers/smart-route-handler", () => ({
  createSmartRouteHandler: (...args: readonly unknown[]) => {
    const definition = args.at(-1);
    if (typeof definition !== "object" || definition === null) throw new Error("route definition is missing");
    return { overloads: new Map([[undefined, definition]]) };
  },
}));
vi.mock("@/lib/issues/saved-search-views/api", () => ({
  createSavedIssueSearchViewResponse: vi.fn(),
  deleteSavedIssueSearchViewForActor: vi.fn(),
  getSavedIssueSearchViewResponse: vi.fn(),
  listSavedIssueSearchViewResponses: vi.fn(),
  parseSavedIssueSearchViewListLimit: vi.fn(),
  updateSavedIssueSearchViewResponse: vi.fn(),
}));

import { GET, POST } from "./route";
import { DELETE, GET as GET_DETAILS, PUT } from "./[view_id]/route";

const adminAuth = { type: "admin", tenancy: {} };
const validBody = {
  name: "Errors",
  visibility: "project",
  query: { version: 1, filters: { record: "issue", hours: "24", limit: "50" } },
};

describe("internal dashboard saved issue search view routes", () => {
  it("requires admin authentication for collection routes", async () => {
    const getRoute = [...GET.overloads.values()].at(0);
    const postRoute = [...POST.overloads.values()].at(0);
    if (getRoute === undefined || postRoute === undefined) throw new Error("collection routes did not register");
    await expect(getRoute.request.validate({ auth: { type: "server", tenancy: {} }, query: {} }, { context: {} })).rejects.toThrow();
    await expect(postRoute.request.validate({ auth: { type: "server", tenancy: {} }, body: validBody }, { context: {} })).rejects.toThrow();
    await expect(getRoute.request.validate({ auth: adminAuth, query: {} }, { context: {} })).resolves.toBeDefined();
  });

  it("requires admin authentication and UUID params for detail routes", async () => {
    const getDetail = [...GET_DETAILS.overloads.values()].at(0);
    const putDetail = [...PUT.overloads.values()].at(0);
    const deleteDetail = [...DELETE.overloads.values()].at(0);
    if (getDetail === undefined || putDetail === undefined || deleteDetail === undefined) throw new Error("detail routes did not register");
    await expect(getDetail.request.validate({ auth: { type: "server", tenancy: {} }, params: { view_id: "11111111-1111-4111-8111-111111111111" } }, { context: {} })).rejects.toThrow();
    await expect(putDetail.request.validate({ auth: { type: "server", tenancy: {} }, params: { view_id: "11111111-1111-4111-8111-111111111111" }, body: validBody }, { context: {} })).rejects.toThrow();
    await expect(deleteDetail.request.validate({ auth: { type: "server", tenancy: {} }, params: { view_id: "11111111-1111-4111-8111-111111111111" } }, { context: {} })).rejects.toThrow();
    await expect(getDetail.request.validate({ auth: adminAuth, params: { view_id: "not-a-uuid" } }, { context: {} })).rejects.toThrow();
  });

  it("rejects scope and cursor fields at the dashboard boundary", async () => {
    const postRoute = [...POST.overloads.values()].at(0);
    const getRoute = [...GET.overloads.values()].at(0);
    if (postRoute === undefined || getRoute === undefined) throw new Error("collection routes did not register");
    await expect(postRoute.request.validate({
      auth: adminAuth,
      body: { ...validBody, project_id: "other-project" },
    }, { context: { noUnknownPathPrefixes: ["body"] } })).rejects.toThrow();
    await expect(getRoute.request.validate({
      auth: adminAuth,
      query: { cursor: "not-supported" },
    }, { context: { noUnknownPathPrefixes: ["query"] } })).rejects.toThrow();
  });
});
