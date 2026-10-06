import "server-only";

import { StackServerApp } from "@hexclave/next";
import {
  OBSERVABILITY_DEMO_ENVIRONMENT,
  OBSERVABILITY_DEMO_RELEASE,
} from "./observability-lab-contract";

export const hexclaveServerApp = new StackServerApp({
  tokenStore: "nextjs-cookie",
  urls: {
    signIn: { type: "hosted" },
    signUp: { type: "custom", url: "/auth/sign-up", version: 0 },
    default: {
      "type": "hosted",
    },
  },
  analytics: {
    enabled: true,
    integritySignals: true,
    replays: {
      enabled: true,
      captureKeystrokes: true,
      maskAllInputs: true,
    },
  },
  observability: {
    enabled: true,
    traceSampleRate: 1,
    errorCapture: {
      ignoreErrors: ["Hexclave observability demo: ignored by policy"],
    },
    logs: {
      captureConsole: ["log", "warn", "error", "info", "debug"],
    },
    network: {
      enabled: true,
    },
  },
  telemetry: {
    resource: {
      service: {
        name: "example-demo",
        version: OBSERVABILITY_DEMO_RELEASE,
      },
      deploymentEnvironmentName: OBSERVABILITY_DEMO_ENVIRONMENT,
    },
  },
});
