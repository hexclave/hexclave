import type { SessionReplayRender } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createPresignedDownloadUrl, createPresignedUploadUrl, downloadByteRange, headBytes } from "@/s3";
import { KnownErrors } from "@hexclave/shared";
import { captureError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { computeReplayTabLabelIndex } from "@hexclave/shared/dist/utils/session-replay-timeline";
import { getReplayRenderRuntime, getRuntimeByName } from "./runtime";
import { FREESTYLE_RENDER_VM_TTL_SECONDS } from "./runtime-freestyle";
import type { ReplayRenderHandle, ReplayRenderJobParams, ReplayRenderResult } from "./types";

type TenancyPrisma = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

export const SESSION_REPLAY_RENDER_LIMITS = {
  /** Renders that are queued or rendering at once, per project. */
  maxActivePerTenancy: 3,
  /** Stored (compressed) size of the recording data being rendered. */
  maxRecordingBytes: 256 * 1024 * 1024,
  /** Length of the output video. */
  maxOutputSeconds: 10 * 60,
  /** Wall-clock budget for one render, start to upload; stays inside the VM's own TTL. */
  maxRenderMs: (FREESTYLE_RENDER_VM_TTL_SECONDS - 5 * 60) * 1000,
} as const;

const LEASE_MS = 60_000;
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

export type SessionReplayRenderOptions = {
  fps: number,
  speed: number,
  skipInactivity: boolean,
};

export type SessionReplayRenderApi = {
  id: string,
  session_replay_id: string,
  /** Null when the whole replay is rendered, following the active tab. */
  session_replay_segment_id: string | null,
  status: "queued" | "rendering" | "succeeded" | "failed",
  progress: number | null,
  options: { fps: number, speed: number, skip_inactivity: boolean },
  error_message: string | null,
  created_at_millis: number,
  started_at_millis: number | null,
  finished_at_millis: number | null,
  video: {
    url: string,
    url_expires_at_millis: number,
    byte_length: number,
    width: number,
    height: number,
    duration_ms: number,
  } | null,
};

function outputKey(tenancyId: string, renderId: string) {
  return `session-replay-renders/${tenancyId}/${renderId}.mp4`;
}

/**
 * Validates the request, records a QUEUED render and starts it before returning,
 * so callers see RENDERING (or FAILED) straight away.
 */
export async function createSessionReplayRender(options: {
  prisma: TenancyPrisma,
  tenancyId: string,
  sessionReplayId: string,
  sessionReplaySegmentId: string | null,
  renderOptions: SessionReplayRenderOptions,
}): Promise<SessionReplayRender> {
  const { prisma, tenancyId, sessionReplayId } = options;

  const replay = await prisma.sessionReplay.findUnique({
    where: { tenancyId_id: { tenancyId, id: sessionReplayId } },
    select: { id: true },
  });
  if (replay == null) {
    throw new KnownErrors.ItemNotFound(sessionReplayId);
  }

  const segments = await prisma.sessionReplayChunk.groupBy({
    by: ["sessionReplaySegmentId"],
    where: { tenancyId, sessionReplayId },
    _sum: { byteLength: true, eventCount: true },
  });
  if (segments.length === 0) {
    throw new StatusError(StatusError.BadRequest, "This session replay has no recorded data to render.");
  }
  // No segment means the whole replay, following the active tab like the player.
  let included = segments;
  if (options.sessionReplaySegmentId != null) {
    included = segments.filter((s) => s.sessionReplaySegmentId === options.sessionReplaySegmentId);
    if (included.length === 0) {
      throw new StatusError(StatusError.BadRequest, "This session replay has no segment with that session_replay_segment_id.");
    }
  }
  const includedBytes = included.reduce((sum, s) => sum + (s._sum.byteLength ?? 0), 0);
  if (includedBytes > SESSION_REPLAY_RENDER_LIMITS.maxRecordingBytes) {
    throw new StatusError(StatusError.BadRequest, "This session replay is too large to render.");
  }

  const active = await prisma.sessionReplayRender.count({
    where: { tenancyId, status: { in: ["QUEUED", "RENDERING"] } },
  });
  if (active >= SESSION_REPLAY_RENDER_LIMITS.maxActivePerTenancy) {
    throw new StatusError(429, `Only ${SESSION_REPLAY_RENDER_LIMITS.maxActivePerTenancy} session replay renders can run at once per project. Wait for one to finish and try again.`);
  }

  const render = await prisma.sessionReplayRender.create({
    data: {
      tenancyId,
      sessionReplayId,
      sessionReplaySegmentId: options.sessionReplaySegmentId,
      options: options.renderOptions,
    },
  });
  return await advanceSessionReplayRender(prisma, tenancyId, render.id);
}

/**
 * Moves a render one step forward: QUEUED → start it; RENDERING → check on it
 * and, once the renderer exits, verify the upload and finish. Safe to call from
 * any number of requests at once — a lease makes all but one of them a read.
 */
export async function advanceSessionReplayRender(prisma: TenancyPrisma, tenancyId: string, renderId: string): Promise<SessionReplayRender> {
  const now = new Date();
  const claimed = await prisma.sessionReplayRender.updateMany({
    where: {
      tenancyId,
      id: renderId,
      status: { in: ["QUEUED", "RENDERING"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) {
    return await getRenderOrThrow(prisma, tenancyId, renderId);
  }

  try {
    const render = await getRenderOrThrow(prisma, tenancyId, renderId);
    if (render.status === "QUEUED") {
      return await startRender(prisma, render);
    }
    return await checkRender(prisma, render);
  } finally {
    await prisma.sessionReplayRender.updateMany({
      where: { tenancyId, id: renderId },
      data: { leaseUntil: null },
    });
  }
}

async function getRenderOrThrow(prisma: TenancyPrisma, tenancyId: string, renderId: string) {
  const render = await prisma.sessionReplayRender.findUnique({ where: { tenancyId_id: { tenancyId, id: renderId } } });
  if (render == null) {
    throw new KnownErrors.ItemNotFound(renderId);
  }
  return render;
}

function readOptions(render: SessionReplayRender): SessionReplayRenderOptions {
  const options = render.options as Partial<SessionReplayRenderOptions> | null;
  return {
    fps: options?.fps ?? 15,
    speed: options?.speed ?? 1,
    skipInactivity: options?.skipInactivity ?? true,
  };
}

async function startRender(prisma: TenancyPrisma, render: SessionReplayRender): Promise<SessionReplayRender> {
  const runtime = getReplayRenderRuntime();
  const key = outputKey(render.tenancyId, render.id);
  let handle: ReplayRenderHandle;
  try {
    // Every chunk of the replay: "Tab N" labels are numbered across all tabs,
    // even when only one of them is rendered.
    const chunks = await prisma.sessionReplayChunk.findMany({
      where: { tenancyId: render.tenancyId, sessionReplayId: render.sessionReplayId },
      orderBy: [{ firstEventAt: "asc" }, { createdAt: "asc" }],
      select: { s3Key: true, sessionReplaySegmentId: true, firstEventAt: true, lastEventAt: true },
    });
    const included = chunks.filter((c) => render.sessionReplaySegmentId == null || c.sessionReplaySegmentId === render.sessionReplaySegmentId);
    if (included.length === 0 || included.some((c) => c.s3Key.startsWith("preview://"))) {
      return await failRender(prisma, render, "This session replay has no stored recording data to render.");
    }
    const chunksByTab = new Map<string, typeof chunks>();
    for (const chunk of chunks) {
      chunksByTab.set(chunk.sessionReplaySegmentId, [...(chunksByTab.get(chunk.sessionReplaySegmentId) ?? []), chunk]);
    }
    const labelIndex = computeReplayTabLabelIndex([...chunksByTab].map(([tabKey, tabChunks]) => ({
      tabKey,
      firstEventAtMs: Math.min(...tabChunks.map((c) => c.firstEventAt.getTime())),
    })));
    // URLs outlive the render budget so a slow render never loses access mid-way.
    const urlTtlSeconds = Math.ceil(SESSION_REPLAY_RENDER_LIMITS.maxRenderMs / 1000) + 5 * 60;
    const options = readOptions(render);
    const tabs: ReplayRenderJobParams["tabs"] = [];
    for (const [tabKey, tabChunks] of chunksByTab) {
      if (render.sessionReplaySegmentId != null && tabKey !== render.sessionReplaySegmentId) continue;
      tabs.push({
        tab_key: tabKey,
        label_index: labelIndex.get(tabKey) ?? tabs.length + 1,
        chunks: await Promise.all(tabChunks.map(async (c) => ({
          url: await createPresignedDownloadUrl({ key: c.s3Key, private: true, expiresInSeconds: urlTtlSeconds }),
          first_event_at_ms: c.firstEventAt.getTime(),
          last_event_at_ms: c.lastEventAt.getTime(),
        }))),
      });
    }
    const params: ReplayRenderJobParams = {
      tabs,
      upload_url: await createPresignedUploadUrl({ key, private: true, contentType: "video/mp4", expiresInSeconds: urlTtlSeconds }),
      fps: options.fps,
      speed: options.speed,
      skip_inactivity: options.skipInactivity,
      max_output_seconds: SESSION_REPLAY_RENDER_LIMITS.maxOutputSeconds,
    };
    handle = await runtime.start(params);
  } catch (error) {
    captureError("session-replay-render-start", error);
    return await failRender(prisma, render, "The renderer could not be started. Please try again.");
  }
  return await prisma.sessionReplayRender.update({
    where: { tenancyId_id: { tenancyId: render.tenancyId, id: render.id } },
    data: {
      status: "RENDERING",
      runtime: runtime.name,
      runtimeHandle: handle,
      outputS3Key: key,
      progress: 0,
      startedAt: new Date(),
    },
  });
}

async function checkRender(prisma: TenancyPrisma, render: SessionReplayRender): Promise<SessionReplayRender> {
  const runtime = getRuntimeByName(render.runtime ?? "");
  const handle = render.runtimeHandle as ReplayRenderHandle;

  const startedAt = render.startedAt ?? render.createdAt;
  if (Date.now() - startedAt.getTime() > SESSION_REPLAY_RENDER_LIMITS.maxRenderMs) {
    await disposeQuietly(runtime.dispose(handle));
    return await failRender(prisma, render, "Rendering took too long and was stopped.");
  }

  let poll;
  try {
    poll = await runtime.poll(handle);
  } catch (error) {
    // Transient (network, provider hiccup): the next poll or cron tick retries,
    // and the time budget above bounds how long that can go on.
    captureError("session-replay-render-poll", error);
    return render;
  }

  if (poll.state === "running") {
    if (poll.progress == null || poll.progress === render.progress) return render;
    return await prisma.sessionReplayRender.update({
      where: { tenancyId_id: { tenancyId: render.tenancyId, id: render.id } },
      data: { progress: poll.progress },
    });
  }

  await disposeQuietly(runtime.dispose(handle));
  const result = poll.result;
  if (result?.status !== "ok") {
    if (result?.status !== "error" || result.error === "The renderer failed unexpectedly.") {
      captureError("session-replay-render-failed", new Error(`Replay renderer exited with code ${poll.exitCode}`, { cause: { renderId: render.id, log: poll.log } }));
    }
    return await failRender(prisma, render, result?.status === "error" ? result.error : "The renderer stopped unexpectedly.");
  }
  return await finishRender(prisma, render, result);
}

async function finishRender(
  prisma: TenancyPrisma,
  render: SessionReplayRender,
  result: Extract<ReplayRenderResult, { status: "ok" }>,
): Promise<SessionReplayRender> {
  const key = render.outputS3Key ?? outputKey(render.tenancyId, render.id);
  // The object was written through a URL handed to the render machine, so check
  // it is what the renderer says it is before offering it to anyone.
  const head = await headBytes({ key, private: true });
  const header = head == null ? null : await downloadByteRange({ key, private: true, start: 0, end: 11 });
  const isMp4 = header != null && header.length >= 8 && Buffer.from(header.subarray(4, 8)).toString("latin1") === "ftyp";
  if (head == null || head.byteLength !== result.output_bytes || !isMp4) {
    captureError("session-replay-render-invalid-output", new Error("Rendered video failed validation", { cause: { renderId: render.id, head, expectedBytes: result.output_bytes, isMp4 } }));
    return await failRender(prisma, render, "The rendered video could not be verified.");
  }
  return await prisma.sessionReplayRender.update({
    where: { tenancyId_id: { tenancyId: render.tenancyId, id: render.id } },
    data: {
      status: "SUCCEEDED",
      progress: 1,
      outputS3Key: key,
      outputByteLength: head.byteLength,
      outputWidth: result.width,
      outputHeight: result.height,
      outputDurationMs: result.output_duration_ms,
      finishedAt: new Date(),
    },
  });
}

async function failRender(prisma: TenancyPrisma, render: SessionReplayRender, message: string) {
  return await prisma.sessionReplayRender.update({
    where: { tenancyId_id: { tenancyId: render.tenancyId, id: render.id } },
    data: { status: "FAILED", errorMessage: message, finishedAt: new Date() },
  });
}

async function disposeQuietly(promise: Promise<void>) {
  try {
    await promise;
  } catch (error) {
    // The VM's own TTL deletes it eventually; a failed delete only costs time.
    captureError("session-replay-render-dispose", error);
  }
}

export async function listSessionReplayRenders(prisma: TenancyPrisma, tenancyId: string, sessionReplayId: string) {
  const renders = await prisma.sessionReplayRender.findMany({
    where: { tenancyId, sessionReplayId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // Listing is also a status poll, so in-flight renders keep moving for callers
  // that only ever list.
  return await Promise.all(renders.map(async (r) => r.status === "QUEUED" || r.status === "RENDERING"
    ? await advanceSessionReplayRender(prisma, tenancyId, r.id)
    : r));
}

export async function getSessionReplayRender(prisma: TenancyPrisma, tenancyId: string, sessionReplayId: string, renderId: string) {
  const render = await getRenderOrThrow(prisma, tenancyId, renderId);
  if (render.sessionReplayId !== sessionReplayId) {
    throw new KnownErrors.ItemNotFound(renderId);
  }
  return render.status === "QUEUED" || render.status === "RENDERING"
    ? await advanceSessionReplayRender(prisma, tenancyId, renderId)
    : render;
}

/**
 * Cron fallback for renders nobody is polling. Only sees renders stored in the
 * global database; renders of projects with their own source of truth advance
 * when they are polled.
 */
export async function advanceStaleSessionReplayRenders(): Promise<{ advanced: number }> {
  const now = new Date();
  const stale = await globalPrismaClient.sessionReplayRender.findMany({
    where: {
      status: { in: ["QUEUED", "RENDERING"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      updatedAt: { lt: new Date(now.getTime() - 10_000) },
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
    select: { tenancyId: true, id: true },
  });
  for (const render of stale) {
    try {
      await advanceSessionReplayRender(globalPrismaClient, render.tenancyId, render.id);
    } catch (error) {
      captureError("session-replay-render-cron", error);
    }
  }
  return { advanced: stale.length };
}

export async function sessionReplayRenderToApi(render: SessionReplayRender): Promise<SessionReplayRenderApi> {
  const options = readOptions(render);
  let video: SessionReplayRenderApi["video"] = null;
  if (render.status === "SUCCEEDED" && render.outputS3Key != null) {
    video = {
      url: await createPresignedDownloadUrl({
        key: render.outputS3Key,
        private: true,
        expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
        downloadFilename: `session-replay-${render.sessionReplayId}.mp4`,
      }),
      url_expires_at_millis: Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000,
      byte_length: render.outputByteLength ?? 0,
      width: render.outputWidth ?? 0,
      height: render.outputHeight ?? 0,
      duration_ms: render.outputDurationMs ?? 0,
    };
  }
  return {
    id: render.id,
    session_replay_id: render.sessionReplayId,
    session_replay_segment_id: render.sessionReplaySegmentId,
    status: render.status.toLowerCase() as SessionReplayRenderApi["status"],
    progress: render.status === "SUCCEEDED" ? 1 : render.progress,
    options: { fps: options.fps, speed: options.speed, skip_inactivity: options.skipInactivity },
    error_message: render.errorMessage,
    created_at_millis: render.createdAt.getTime(),
    started_at_millis: render.startedAt?.getTime() ?? null,
    finished_at_millis: render.finishedAt?.getTime() ?? null,
    video,
  };
}

