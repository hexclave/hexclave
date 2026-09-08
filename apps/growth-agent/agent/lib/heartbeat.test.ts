import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  phaseHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("#lib/hexclave-client.ts", () => ({
  phaseHeartbeat: mocks.phaseHeartbeat,
}));

import { startPhaseHeartbeat } from "#lib/heartbeat.ts";

const input = {
  project_id: "project-1",
  branch_id: "main",
  run_id: "run-1",
  phase_key: "report",
  attempt: 1,
};

describe("startPhaseHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.phaseHeartbeat.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("beats once per minute until stopped", async () => {
    const stop = startPhaseHeartbeat(input);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.phaseHeartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.phaseHeartbeat).toHaveBeenLastCalledWith(input);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.phaseHeartbeat).toHaveBeenCalledTimes(2);
  });
});
