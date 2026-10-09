import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Run against shared source in a clean checkout without building the entire SDK workspace.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@hexclave\/shared\/dist\/(.*)$/, replacement: `${fileURLToPath(new URL("../../packages/shared/src/", import.meta.url))}$1` }],
  },
  define: { "import.meta.vitest": "undefined" },
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
