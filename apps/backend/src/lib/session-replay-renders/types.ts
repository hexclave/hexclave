/**
 * What the renderer (scripts/replay-render/render.mjs) reads from params.json.
 * Data only: the machine that runs the renderer gets these URLs and nothing else.
 */
export type ReplayRenderJobParams = {
  events_urls: string[],
  upload_url: string,
  fps: number,
  speed: number,
  skip_inactivity: boolean,
  max_output_seconds: number,
};

/** The renderer's result.json. */
export type ReplayRenderResult =
  | {
    status: "ok",
    width: number,
    height: number,
    fps: number,
    frame_count: number,
    replay_duration_ms: number,
    output_duration_ms: number,
    output_bytes: number,
    failed_requests: number,
    failed_origins: string[],
    render_ms: number,
    warnings: string[],
  }
  | {
    status: "error",
    error: string,
  };

export type ReplayRenderPoll =
  | { state: "running", progress: number | null }
  | { state: "exited", exitCode: number, result: ReplayRenderResult | null, log: string };

/** Opaque, JSON-serializable reference to a started job, stored on the render row. */
export type ReplayRenderHandle = Record<string, string>;

/**
 * Where renders run. Every method is a short call, so the backend can advance a
 * render from any request without holding a connection open while it renders.
 */
export type ReplayRenderRuntime = {
  name: "freestyle" | "mock",
  start(params: ReplayRenderJobParams): Promise<ReplayRenderHandle>,
  poll(handle: ReplayRenderHandle): Promise<ReplayRenderPoll>,
  /** Stops the job if it is still running and frees its resources. Idempotent. */
  dispose(handle: ReplayRenderHandle): Promise<void>,
};

export function parseProgress(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const { frame, total } = value as { frame?: unknown, total?: unknown };
  if (typeof frame !== "number" || typeof total !== "number" || total <= 0) return null;
  return Math.min(1, Math.max(0, frame / total));
}

export function parseResult(value: unknown): ReplayRenderResult | null {
  if (typeof value !== "object" || value === null || !("status" in value)) return null;
  if (value.status === "ok") return value as ReplayRenderResult;
  if (value.status === "error" && "error" in value && typeof value.error === "string") return value as ReplayRenderResult;
  return null;
}
