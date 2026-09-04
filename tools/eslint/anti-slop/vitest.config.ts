import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "anti-slop",
    include: ["plugin.test.ts"],
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 1 } },
  },
});
