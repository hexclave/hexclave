import type { TelemetrySettings } from "ai";

export function getAiTelemetry(functionId: string): TelemetrySettings {
  return {
    isEnabled: true,
    functionId,
    recordInputs: false,
    recordOutputs: false,
  };
}
