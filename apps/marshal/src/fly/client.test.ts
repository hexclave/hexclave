import { afterEach, describe, expect, it, vi } from "vitest";

const flyConfiguration = {
  machinesApiUrl: "https://machines.example.com",
  graphqlApiUrl: "https://graphql.example.com",
};
vi.mock("../config.js", () => ({
  MOCK_FLY_TOKEN: "mock_hexclave_fly_key",
  getConfig: () => ({ fly: flyConfiguration }),
  flyConfig: () => flyConfiguration,
}));

import { MutationOutcomeUnknownError } from "../mutation-safety.js";
import { FlyApiError, FlyClient } from "./client.js";

function responseWithFailingBody(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("response body reset"));
    },
  });
  return new Response(body, { status: 200 });
}

describe("Fly mutation response handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a REST write response-body failure as an unknown mutation outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseWithFailingBody()));
    const fly = new FlyClient("token", "org");

    await expect(fly.createApp("app", "network")).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("classifies a GraphQL write response-body failure as an unknown mutation outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseWithFailingBody()));
    const fly = new FlyClient("token", "org");

    await expect(fly.allocateIp("app", "shared_v4")).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });
});

describe("Fly app provisioning lookups", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a GraphQL read to create a missing app without a slow REST miss", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: "Could not find App" }] }))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await new FlyClient("token", "org").ensureApp("app", "network");

    expect(fetch.mock.calls.map(([url, init]) => ({ url, method: init.method, body: JSON.parse(init.body) })))
      .toMatchInlineSnapshot(`
        [
          {
            "body": {
              "query": "query($app: String!) { app(name: $app) { name } }",
              "variables": {
                "app": "app",
              },
            },
            "method": "POST",
            "url": "https://graphql.example.com",
          },
          {
            "body": {
              "app_name": "app",
              "network": "network",
              "org_slug": "org",
            },
            "method": "POST",
            "url": "https://machines.example.com/v1/apps",
          },
        ]
      `);
  });

  it("leaves an existing app alone", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { app: { name: "app" } } }));
    vi.stubGlobal("fetch", fetch);
    await new FlyClient("token", "org").ensureApp("app", "network");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([409, 422])("confirms the app after a concurrent create returns %s", async (status) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { app: null } }))
      .mockResolvedValueOnce(Response.json({ error: "already exists" }, { status }))
      .mockResolvedValueOnce(Response.json({ data: { app: { name: "app" } } }));
    vi.stubGlobal("fetch", fetch);
    await new FlyClient("token", "org").ensureApp("app", "network");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves a create failure when the app still does not exist", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { app: null } }))
      .mockResolvedValueOnce(Response.json({ error: "invalid network" }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ data: { app: null } }));
    vi.stubGlobal("fetch", fetch);
    await expect(new FlyClient("token", "org").ensureApp("app", "network"))
      .rejects.toMatchObject({ status: 422, flyMessage: "invalid network" });
  });

  it.each([401, 403, 429, 500])("does not create after a failed lookup (HTTP %s)", async (status) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ errors: [{ message: "Could not find App" }] }, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(new FlyClient("token", "org").ensureApp("app", "network")).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { data: {} },
    { data: { app: { name: "another-app" } } },
    { errors: [{ message: "Could not find App" }, { message: "permission denied" }] },
  ])("rejects an unexpected lookup response without creating", async (body) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetch);
    await expect(new FlyClient("token", "org").ensureApp("app", "network")).rejects.toBeInstanceOf(FlyApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a socket failure during the lookup but never repeats the create", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket reset"))
      .mockResolvedValueOnce(Response.json({ data: { app: null } }))
      .mockRejectedValueOnce(new TypeError("write socket reset"));
    vi.stubGlobal("fetch", fetch);
    await expect(new FlyClient("token", "org").ensureApp("app", "network"))
      .rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
