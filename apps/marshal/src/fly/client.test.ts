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
import { FlyClient } from "./client.js";

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
