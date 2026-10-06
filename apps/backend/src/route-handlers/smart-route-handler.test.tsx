import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest } from "./smart-route-handler";

const state = vi.hoisted(() => ({
  captureInternalRequestError: vi.fn(async () => {}),
}));

vi.mock("@/lib/internal-observability", () => ({
  captureInternalRequestError: state.captureInternalRequestError,
  runWithInternalRequestObservability: async (
    _request: Request,
    _requestId: string,
    fn: () => Promise<Response>,
  ) => await fn(),
}));

describe("smart route error capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports an unexpected route failure to internal Issues", async () => {
    const error = new Error("query failed");
    const request = new Request("http://localhost:8102/api/v1/internal/sign-up-rules-stats");
    const handler = handleApiRequest(async () => {
      throw error;
    });

    const response = await handler(request, {});

    expect(response.status).toBe(500);
    expect(state.captureInternalRequestError).toHaveBeenCalledWith(error, request, expect.any(String));
  });

  it("does not turn an intentional status response into an Issue", async () => {
    const error = new StatusError(StatusError.ServiceUnavailable);
    const request = new Request("http://localhost:8102/api/v1/maintenance");
    const handler = handleApiRequest(async () => {
      throw error;
    });

    const response = await handler(request, {});

    expect(response.status).toBe(503);
    expect(state.captureInternalRequestError).not.toHaveBeenCalled();
  });

  it("preserves the original 500 response if issue capture fails", async () => {
    state.captureInternalRequestError.mockRejectedValueOnce(new Error("collector unavailable"));
    const request = new Request("http://localhost:8102/api/v1/internal/sign-up-rules-stats");
    const handler = handleApiRequest(async () => {
      throw new Error("query failed");
    });

    const response = await handler(request, {});

    expect(response.status).toBe(500);
    expect(state.captureInternalRequestError).toHaveBeenCalledOnce();
  });
});
