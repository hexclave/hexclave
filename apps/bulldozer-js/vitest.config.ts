import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Child processes, not worker threads: tests then run on a main thread with the same stack size
      // as the production server. Worker threads get ~4x more stack, which hid stack-overflow bugs that
      // crashed prod (see src/test-stack-size.test.ts).
      pool: "forks",
      poolOptions: {
        forks: {
          minForks: 1,
          maxForks: 8,
        },
      },
      exclude: [
        ...configDefaults.exclude,
        "dist/**",
        "old-bulldozer-perf-test-file.test.ts",
      ],
    },
  }),
);
