import { defineConfig } from "vitest/config";

// Plain-JS app with no build step: the unit tests import server.mjs directly.
export default defineConfig({ test: { include: ["*.test.mjs"] } });
