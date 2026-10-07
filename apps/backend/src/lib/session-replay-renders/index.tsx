import type { Prisma, SessionReplayRender } from "@/generated/prisma/client";
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
  /**
   * Stored (gzipped) size of the recording data being rendered. The renderer
   * caps the decompressed events at 512 MB (scripts/replay-render/render.mjs);
   * replay JSON compresses ~5-10x, so this rejects too-large replays up front
   * instead of after booting a machine for them.
   */
  maxRecordingBytes: 48 * 1024 * 1024,
  /** Length of the output video. */
  maxOutputSeconds: 10 * 60,
  /** Wall-clock budget for one render, start to upload; stays inside the VM's own TTL. */
  maxRenderMs: (FREESTYLE_RENDER_VM_TTL_SECONDS - 5 * 60) * 1000,
} as const;

/**
 * How long one request may advance a render before another may take over.
 * Longer than any single step (a VM start, or a poll, is a handful of calls
 * with 30s timeouts), so a live advancer is never overtaken.
 */
const LEASE_MS = 3 * 60_000;
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

// TODO: rendered videos are never deleted — not when a render fails, nor when
// its replay is deleted (the row cascades, the object stays). Add a lifecycle
// rule on this prefix or delete objects explicitly once retention is decided.
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
  await assertReplayExists(prisma, tenancyId, sessionReplayId);

  const segments = await prisma.sessionReplayChunk.groupBy({
    by: ["sessionReplaySegmentId"],
    where: { tenancyId, sessionReplayId },
    _sum: { byteLength: true },
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

  // Renders older than the render budget are counted as abandoned rather than
  // active: a render nobody polls (and the cron doesn't reach, see
  // advanceStaleSessionReplayRenders) must not block new ones forever.
  // TODO: count + create is not atomic, so concurrent requests can exceed the
  // limit by a few; a per-tenancy advisory lock would make it exact.
  const active = await prisma.sessionReplayRender.count({
    where: {
      tenancyId,
      status: { in: ["QUEUED", "RENDERING"] },
      createdAt: { gt: new Date(Date.now() - SESSION_REPLAY_RENDER_LIMITS.maxRenderMs - LEASE_MS) },
    },
  });
  if (active >= SESSION_REPLAY_RENDER_LIMITS.maxActivePerTenancy) {
    throw new KnownErrors.SessionReplayRenderLimitReached(SESSION_REPLAY_RENDER_LIMITS.maxActivePerTenancy);
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

async function assertReplayExists(prisma: TenancyPrisma, tenancyId: string, sessionReplayId: string) {
  const replay = await prisma.sessionReplay.findUnique({
    where: { tenancyId_id: { tenancyId, id: sessionReplayId } },
    select: { id: true },
  });
  if (replay == null) {
    throw new KnownErrors.ItemNotFound(sessionReplayId);
  }
}

/**
 * Moves a render one step forward: QUEUED → start it; RENDERING → check on it
 * and, once the renderer exits, verify the upload and finish. Safe to call from
 * any number of requests at once: the claim hands out a lease token, and every
 * state change below only applies while that token still holds the lease and
 * the render is still in progress, so a slow or crashed advancer can never
 * overwrite a newer one's work or a finished render.
 */
export async function advanceSessionReplayRender(prisma: TenancyPrisma, tenancyId: string, renderId: string): Promise<SessionReplayRender> {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const claimed = await prisma.sessionReplayRender.updateMany({
    where: {
      tenancyId,
      id: renderId,
      status: { in: ["QUEUED", "RENDERING"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseToken },
  });
  if (claimed.count === 0) {
    return await getRenderOrThrow(prisma, tenancyId, renderId);
  }

  const lease: Lease = { prisma, tenancyId, renderId, leaseToken };
  try {
    const render = await getRenderOrThrow(prisma, tenancyId, renderId);
    if (render.status === "QUEUED") {
      return await startRender(lease, render);
    }
    return await checkRender(lease, render);
  } finally {
    await prisma.sessionReplayRender.updateMany({
      where: { tenancyId, id: renderId, leaseToken },
      data: { leaseUntil: null, leaseToken: null },
    });
  }
}

/**
 * Advances a render on behalf of a status read. A failure here (S3 or provider
 * hiccup, database error) must not fail the read: report it and show the
 * render as stored; the next poll retries.
 */
async function advanceForRead(prisma: TenancyPrisma, render: SessionReplayRender): Promise<SessionReplayRender> {
  if (render.status !== "QUEUED" && render.status !== "RENDERING") return render;
  try {
    return await advanceSessionReplayRender(prisma, render.tenancyId, render.id);
  } catch (error) {
    captureError("session-replay-render-advance", error);
    return render;
  }
}

type Lease = {
  prisma: TenancyPrisma,
  tenancyId: string,
  renderId: string,
  leaseToken: string,
};

/** Applies a state change if this lease still holds an in-progress render; returns whether it did. */
async function transition(lease: Lease, data: Prisma.SessionReplayRenderUpdateManyMutationInput): Promise<boolean> {
  const result = await lease.prisma.sessionReplayRender.updateMany({
    where: {
      tenancyId: lease.tenancyId,
      id: lease.renderId,
      leaseToken: lease.leaseToken,
      status: { in: ["QUEUED", "RENDERING"] },
    },
    data,
  });
  return result.count > 0;
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

async function startRender(lease: Lease, render: SessionReplayRender): Promise<SessionReplayRender> {
  const { prisma } = lease;
  // startedAt is set before the runtime is asked for a machine. Seeing it here
  // means an earlier start attempt never recorded its handle (it crashed, or
  // timed out mid-start): fail rather than risk running the render twice.
  if (render.startedAt != null) {
    return await failRender(lease, "The renderer could not be started. Please try again.");
  }
  if (!await transition(lease, { startedAt: new Date() })) {
    return await getRenderOrThrow(prisma, lease.tenancyId, lease.renderId);
  }

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
      return await failRender(lease, "This session replay has no stored recording data to render.");
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
    return await failRender(lease, "The renderer could not be started. Please try again.");
  }

  let recorded = false;
  try {
    recorded = await transition(lease, {
      status: "RENDERING",
      runtime: runtime.name,
      runtimeHandle: handle,
      outputS3Key: key,
      progress: 0,
    });
  } finally {
    // A machine nobody can find again would run until its TTL.
    if (!recorded) await disposeQuietly(runtime.dispose(handle));
  }
  return await getRenderOrThrow(prisma, lease.tenancyId, lease.renderId);
}

async function checkRender(lease: Lease, render: SessionReplayRender): Promise<SessionReplayRender> {
  const { prisma } = lease;
  let runtime;
  try {
    runtime = getRuntimeByName(render.runtime ?? "");
  } catch (error) {
    // Started under a runtime this backend no longer uses (e.g. the Freestyle
    // key changed between mock and real): it can never be polled again.
    captureError("session-replay-render-runtime-mismatch", error);
    return await failRender(lease, "The renderer was reconfigured while this render ran. Please try again.");
  }
  const handle = render.runtimeHandle as ReplayRenderHandle;
  const startedAt = render.startedAt ?? render.createdAt;
  const overBudget = Date.now() - startedAt.getTime() > SESSION_REPLAY_RENDER_LIMITS.maxRenderMs;
  const stopForTime = async () => {
    await disposeQuietly(runtime.dispose(handle));
    return await failRender(lease, "Rendering took too long and was stopped.");
  };

  let poll;
  try {
    poll = await runtime.poll(handle);
  } catch (error) {
    // Transient (network, provider hiccup): the next poll or cron tick retries,
    // bounded by the time budget.
    captureError("session-replay-render-poll", error);
    return overBudget ? await stopForTime() : render;
  }

  if (poll.state === "running") {
    // Checked after polling, so a render that finished just before an overdue
    // poll still counts.
    if (overBudget) return await stopForTime();
    if (poll.progress == null || poll.progress === render.progress) return render;
    await transition(lease, { progress: poll.progress });
    return await getRenderOrThrow(prisma, lease.tenancyId, lease.renderId);
  }

  const result = poll.result;
  if (result?.status !== "ok") {
    if (result?.status !== "error" || result.error === "The renderer failed unexpectedly.") {
      captureError("session-replay-render-failed", new Error(`Replay renderer exited with code ${poll.exitCode}`, { cause: { renderId: render.id, log: poll.log } }));
    }
    await disposeQuietly(runtime.dispose(handle));
    return await failRender(lease, result?.status === "error" ? result.error : "The renderer stopped unexpectedly.");
  }

  // Verify before disposing: if S3 hiccups, the machine (and its result) is
  // still there for the next poll to try again.
  let verification;
  try {
    verification = await verifyOutput(render, result);
  } catch (error) {
    captureError("session-replay-render-verify", error);
    return overBudget ? await stopForTime() : render;
  }
  await disposeQuietly(runtime.dispose(handle));
  if (!verification.ok) {
    captureError("session-replay-render-invalid-output", new Error("Rendered video failed validation", { cause: { renderId: render.id, ...verification } }));
    return await failRender(lease, "The rendered video could not be verified.");
  }
  await transition(lease, {
    status: "SUCCEEDED",
    progress: 1,
    outputByteLength: verification.byteLength,
    outputWidth: result.width,
    outputHeight: result.height,
    outputDurationMs: result.output_duration_ms,
    finishedAt: new Date(),
  });
  return await getRenderOrThrow(prisma, lease.tenancyId, lease.renderId);
}

/**
 * The object was written through a URL handed to the render machine, so check
 * it is what the renderer says it is before offering it to anyone.
 */
async function verifyOutput(render: SessionReplayRender, result: Extract<ReplayRenderResult, { status: "ok" }>) {
  const key = render.outputS3Key ?? outputKey(render.tenancyId, render.id);
  const head = await headBytes({ key, private: true });
  if (head == null || head.byteLength < 12 || head.byteLength !== result.output_bytes) {
    return { ok: false as const, byteLength: head?.byteLength ?? null, expectedBytes: result.output_bytes };
  }
  const header = await downloadByteRange({ key, private: true, start: 0, end: 11 });
  const isMp4 = header.length >= 8 && Buffer.from(header.subarray(4, 8)).toString("latin1") === "ftyp";
  return isMp4
    ? { ok: true as const, byteLength: head.byteLength }
    : { ok: false as const, byteLength: head.byteLength, expectedBytes: result.output_bytes };
}

async function failRender(lease: Lease, message: string): Promise<SessionReplayRender> {
  await transition(lease, { status: "FAILED", errorMessage: message, finishedAt: new Date() });
  return await getRenderOrThrow(lease.prisma, lease.tenancyId, lease.renderId);
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
  await assertReplayExists(prisma, tenancyId, sessionReplayId);
  const renders = await prisma.sessionReplayRender.findMany({
    where: { tenancyId, sessionReplayId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // Listing is also a status poll, so in-flight renders keep moving for callers
  // that only ever list.
  return await Promise.all(renders.map((r) => advanceForRead(prisma, r)));
}

export async function getSessionReplayRender(prisma: TenancyPrisma, tenancyId: string, sessionReplayId: string, renderId: string) {
  const render = await getRenderOrThrow(prisma, tenancyId, renderId);
  if (render.sessionReplayId !== sessionReplayId) {
    throw new KnownErrors.ItemNotFound(renderId);
  }
  return await advanceForRead(prisma, render);
}

const CRON_DEADLINE_MS = 40_000;
const CRON_CONCURRENCY = 4;

/**
 * Cron fallback for renders nobody is polling, worked through a few at a time
 * until a deadline so the invocation never runs into the function time limit
 * (an advancer killed mid-start is exactly what the lease guards against, but
 * it still costs that render).
 *
 * TODO: only renders stored in the global database are seen here. Renders of
 * projects with their own source of truth advance only while polled; abandoned
 * ones stop counting toward the active limit after the render budget (see
 * createSessionReplayRender), but their machines run until the VM TTL.
 */
export async function advanceStaleSessionReplayRenders(): Promise<{ advanced: number }> {
  const started = Date.now();
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
  let advanced = 0;
  const queue = [...stale];
  await Promise.all(Array.from({ length: CRON_CONCURRENCY }, async () => {
    while (queue.length > 0 && Date.now() - started < CRON_DEADLINE_MS) {
      const render = queue.shift()!;
      try {
        await advanceSessionReplayRender(globalPrismaClient, render.tenancyId, render.id);
        advanced++;
      } catch (error) {
        captureError("session-replay-render-cron", error);
      }
    }
  }));
  return { advanced };
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

