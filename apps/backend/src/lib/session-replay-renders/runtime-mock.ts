import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { parseProgress, parseResult, type ReplayRenderRuntime } from "./types";

/**
 * Local development runtime: docker/dependencies/replay-render-mock runs the same
 * render.mjs that Freestyle VMs run, behind a tiny job API.
 */
export function createMockReplayRenderRuntime(): ReplayRenderRuntime {
  const prefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
  const baseUrl = getEnvVariable("STACK_REPLAY_RENDER_MOCK_URL", "") || `http://localhost:${prefix}32`;

  async function request(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok && res.status !== 404) {
      throw new HexclaveAssertionError(`Replay render mock responded with HTTP ${res.status}`, { path, body: await res.text() });
    }
    return res;
  }

  return {
    name: "mock",
    async start(params) {
      const res = await request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
      });
      const body = await res.json();
      if (typeof body?.id !== "string") {
        throw new HexclaveAssertionError("Replay render mock returned no job id", { body });
      }
      return { jobId: body.id };
    },
    async poll(handle) {
      const res = await request(`/jobs/${encodeURIComponent(handle.jobId)}`);
      if (res.status === 404) {
        // The mock keeps jobs in memory, so a container restart loses them.
        return { state: "exited", exitCode: -1, result: null, log: "Job not found on the replay render mock (was it restarted?)" };
      }
      const body = await res.json();
      if (body.state === "running") {
        return { state: "running", progress: parseProgress(body.progress) };
      }
      return { state: "exited", exitCode: body.exit_code ?? -1, result: parseResult(body.result), log: String(body.log ?? "") };
    },
    async dispose(handle) {
      await request(`/jobs/${encodeURIComponent(handle.jobId)}`, { method: "DELETE" });
    },
  };
}
