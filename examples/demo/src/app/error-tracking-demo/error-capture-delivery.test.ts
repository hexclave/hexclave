import { describe, expect, it, vi } from "vitest";
import { deliverErrorCapture } from "./error-capture-delivery";

describe("deliverErrorCapture", () => {
  it("does not confirm a capture until pending telemetry has been flushed", async () => {
    const order: string[] = [];
    const capture = vi.fn(() => {
      order.push("capture");
      return { eventId: "0123456789abcdef0123456789abcdef" };
    });
    const flush = vi.fn(async () => {
      order.push("flush");
    });

    await expect(deliverErrorCapture(capture, flush)).resolves.toEqual({
      eventId: "0123456789abcdef0123456789abcdef",
    });
    expect(order).toEqual(["capture", "flush"]);
  });

  it("does not return a successful capture when delivery fails", async () => {
    const deliveryError = new Error("OTLP delivery failed");

    await expect(deliverErrorCapture(
      () => ({ eventId: "0123456789abcdef0123456789abcdef" }),
      async () => {
        throw deliveryError;
      },
    )).rejects.toBe(deliveryError);
  });
});
