import { defineConfig } from "vitest/config";

// The gateway's own integration test builds a Docker image and runs a Bun
// fixture on an isolated network; run it explicitly with Bun (see README.md),
// never from the normal workspace suite. The parked page's unit tests are
// ordinary and do belong there, so they are included by name rather than the
// whole directory being opted out.
export default defineConfig({ test: { include: ["parked-page/*.test.mjs"] } });
