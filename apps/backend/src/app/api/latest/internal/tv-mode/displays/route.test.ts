import { describe, expect, it, vi } from "vitest";

const consumeTvDisplayPairingRateLimit = vi.hoisted(() => vi.fn());
const refundTvDisplayPairingRateLimit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/end-users", () => ({
  getExactEndUserIp: vi.fn(),
}));

vi.mock("@/lib/tv-mode/displays", () => ({
  approveTvDisplayPairing: vi.fn(),
  consumeTvDisplayPairingRateLimit,
  listTvDisplays: vi.fn(),
  refundTvDisplayPairingRateLimit,
  requireTvDisplayAdminUserId: vi.fn(),
  TvDisplayOperationError: class TvDisplayOperationError extends Error {},
}));

vi.mock("@/route-handlers/smart-route-handler", () => ({
  createSmartRouteHandler: ({ handler }: { handler: unknown }) => handler,
}));

import { consumeTvDisplayApprovalRateLimits } from "./route";

describe("TV display approval rate limits", () => {
  it("refunds only the successful bucket when the other consume fails", async () => {
    const consumeError = new Error("consume failed");
    consumeTvDisplayPairingRateLimit
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(consumeError);
    refundTvDisplayPairingRateLimit.mockResolvedValue(undefined);
    const now = new Date("2026-08-19T00:00:00.000Z");

    await expect(consumeTvDisplayApprovalRateLimits({
      adminUserId: "admin",
      ip: "198.51.100.20",
      now,
    })).rejects.toBe(consumeError);

    expect(refundTvDisplayPairingRateLimit).toHaveBeenCalledTimes(1);
    expect(refundTvDisplayPairingRateLimit).toHaveBeenCalledWith({
      identity: "admin",
      operation: "approval-admin",
      windowMs: 10 * 60_000,
      now,
    });
  });
});
