import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { createFreestyleReplayRenderRuntime } from "./runtime-freestyle";
import { createMockReplayRenderRuntime } from "./runtime-mock";
import type { ReplayRenderRuntime } from "./types";

export function getReplayRenderRuntime(): ReplayRenderRuntime {
  const apiKey = getEnvVariable("STACK_FREESTYLE_API_KEY");
  if (apiKey === "mock_stack_freestyle_key") {
    if (!["development", "test"].includes(getNodeEnvironment())) {
      throw new HexclaveAssertionError("Mock Freestyle key used in production; please set the STACK_FREESTYLE_API_KEY environment variable.");
    }
    return createMockReplayRenderRuntime();
  }
  return createFreestyleReplayRenderRuntime(apiKey);
}

export function getRuntimeByName(name: string): ReplayRenderRuntime {
  const runtime = getReplayRenderRuntime();
  if (runtime.name !== name) {
    // A render started under one runtime can only be polled by that runtime.
    throw new HexclaveAssertionError(`Render was started on the ${name} runtime, but this backend is configured for ${runtime.name}`);
  }
  return runtime;
}
