import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** How many nested calls fit on the current thread's stack before `RangeError: Maximum call stack size exceeded`. */
function measureStackDepth() {
  let depth = 0;
  const recurse = () => {
    depth++;
    recurse();
  };
  try {
    recurse();
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return depth;
}

describe("test environment", () => {
  // Several Breezy bugs were stack overflows that only happened past a certain size. vitest's
  // worker threads have ~4x the stack of Node's main thread, where the production server runs, so
  // inputs that crashed prod passed in tests. This keeps tests on a main-thread-sized stack.
  it("gives tests the same call-stack size as the production server's main thread", () => {
    const mainThread = spawnSync(process.execPath, ["-e", `${measureStackDepth.toString()}; console.log(measureStackDepth())`], { encoding: "utf8" });
    expect(mainThread.status).toBe(0);
    const mainThreadDepth = Number(mainThread.stdout.trim());
    const testDepth = measureStackDepth();
    // The two run slightly different call stacks around the measurement, so allow some slack.
    expect(testDepth / mainThreadDepth).toBeGreaterThan(0.75);
    expect(testDepth / mainThreadDepth).toBeLessThan(1.25);
  });
});
