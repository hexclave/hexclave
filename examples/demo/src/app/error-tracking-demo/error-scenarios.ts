export type ErrorTrackingDemoScenario = {
  mode: "same" | "unique",
  title: string,
  message: string,
  fingerprint: string[],
  instanceKey: string,
};

const DEMO_FINGERPRINT_NAMESPACE = "hexclave-error-tracking-demo";
const REPEATED_ERROR_KEY = "repeatable-client-error";
const REPEATED_ERROR_MESSAGE = "Hexclave error tracking demo: repeatable client error";

export function createRepeatedErrorScenario(): ErrorTrackingDemoScenario {
  return {
    mode: "same",
    title: "Repeatable client error",
    message: REPEATED_ERROR_MESSAGE,
    fingerprint: [DEMO_FINGERPRINT_NAMESPACE, REPEATED_ERROR_KEY],
    instanceKey: REPEATED_ERROR_KEY,
  };
}

export function createUniqueErrorScenario(instanceKey: string): ErrorTrackingDemoScenario {
  if (instanceKey.trim() === "") {
    throw new Error("The unique error scenario requires a non-empty instance key");
  }

  return {
    mode: "unique",
    title: "Unique client error",
    message: `Hexclave error tracking demo: unique client error ${instanceKey}`,
    fingerprint: [DEMO_FINGERPRINT_NAMESPACE, "unique-client-error", instanceKey],
    instanceKey,
  };
}
