import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  StackServerApp: vi.fn(function StackServerApp(options) {
    return { options };
  }),
}));

vi.mock("@hexclave/js", () => ({ StackServerApp: state.StackServerApp }));
vi.mock("@hexclave/shared/dist/utils/env", () => ({
  getEnvBoolean: () => true,
  getEnvVariable: (name: string) => `${name}-value`,
}));

it("dogfoods the SDK-managed OpenTelemetry provider", async () => {
  const { getHexclaveServerApp } = await import("./hexclave");

  getHexclaveServerApp();

  expect(state.StackServerApp).toHaveBeenCalledWith(expect.objectContaining({
    observability: expect.objectContaining({
      enabled: true,
    }),
    telemetry: {
      resource: {
        service: expect.objectContaining({ name: "hexclave-backend" }),
      },
    },
  }));
  expect(state.StackServerApp.mock.calls[0]?.[0].observability).not.toHaveProperty("openTelemetry");
});
