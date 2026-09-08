import type { ChannelFrom } from "eve/channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisPhaseRunRequest } from "#lib/types.ts";

const mocks = vi.hoisted(() => ({
  getProjectContext: vi.fn(async () => ({ website_url: "https://example.com" })),
  phaseFail: vi.fn(async () => undefined),
  phaseStart: vi.fn(async () => undefined),
  runAgentSession: vi.fn(async () => ({ sessionId: "session-1", structuredResult: null })),
  startPhaseHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

vi.mock("#lib/agent-session.ts", () => ({
  SafeRunError: class SafeRunError extends Error {},
  runAgentSession: mocks.runAgentSession,
  safeMessageFromError: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("#lib/hexclave-client.ts", () => ({
  getProjectContext: mocks.getProjectContext,
  phaseFail: mocks.phaseFail,
  phaseStart: mocks.phaseStart,
}));

vi.mock("#lib/heartbeat.ts", () => ({
  startPhaseHeartbeat: mocks.startPhaseHeartbeat,
}));

import { executeAnalysisPhase } from "#lib/run-analysis-phase.ts";

const input: AnalysisPhaseRunRequest = {
  project_id: "project-1",
  branch_id: "main",
  run_id: "run-1",
  phase_key: "report",
  attempt: 1,
  agent_token: "agent-token",
};

describe("executeAnalysisPhase lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startPhaseHeartbeat.mockReturnValue(mocks.stopHeartbeat);
    mocks.runAgentSession.mockResolvedValue({ sessionId: "session-1", structuredResult: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows the durable session while heartbeating the claimed phase", async () => {
    const from: ChannelFrom = vi.fn<[string], ReturnType<ChannelFrom>>();

    await executeAnalysisPhase(input, { from });

    expect(mocks.phaseStart).toHaveBeenCalledWith(input);
    expect(mocks.startPhaseHeartbeat).toHaveBeenCalledWith(input);
    expect(mocks.runAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      from,
      continuationToken: "phase1:project-1:main:run-1:report:1",
      context: {
        project_id: "project-1",
        branch_id: "main",
        run_id: "run-1",
        phase_key: "report",
        finding_source: "report",
        agent_token: "agent-token",
      },
    }));
    expect(mocks.phaseFail).not.toHaveBeenCalled();
    expect(mocks.stopHeartbeat).toHaveBeenCalledOnce();
  });

  it("stops heartbeating and reports a safe failure when the session follower fails", async () => {
    const from: ChannelFrom = vi.fn<[string], ReturnType<ChannelFrom>>();
    mocks.runAgentSession.mockRejectedValueOnce(new Error("private provider detail"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await executeAnalysisPhase(input, { from });

    expect(mocks.phaseFail).toHaveBeenCalledWith({
      ...input,
      error_message: 'The "report" analysis step failed unexpectedly.',
    });
    expect(mocks.stopHeartbeat).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
