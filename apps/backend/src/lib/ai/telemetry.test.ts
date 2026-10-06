import { expect, it } from "vitest";
import { getAiTelemetry } from "./telemetry";

it("enables AI spans without recording prompts or generations", () => {
  expect(getAiTelemetry("hexclave.ai.test")).toEqual({
    isEnabled: true,
    functionId: "hexclave.ai.test",
    recordInputs: false,
    recordOutputs: false,
  });
});
