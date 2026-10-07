import { randomUUID } from "node:crypto";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../backend-helpers";

// Renders run in the replay-render mock locally (or a Freestyle VM in real mode),
// which actually launches Chrome and ffmpeg, so these tests wait for real work.
const RENDER_TIMEOUT_MS = 150_000;

function rrwebEvents(startMs: number, options: { withFullSnapshot: boolean, durationMs?: number }) {
  const meta = { type: 4, timestamp: startMs, data: { href: "https://example.com/", width: 640, height: 480 } };
  const fullSnapshot = {
    type: 2,
    timestamp: startMs + 10,
    data: {
      initialOffset: { left: 0, top: 0 },
      node: {
        type: 0, id: 1, childNodes: [
          { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
          {
            type: 2, id: 3, tagName: "html", attributes: {}, childNodes: [
              { type: 2, id: 4, tagName: "head", attributes: {}, childNodes: [] },
              {
                type: 2, id: 5, tagName: "body", attributes: { style: "margin:0;font-family:sans-serif;background:#f8fafc" }, childNodes: [
                  { type: 2, id: 6, tagName: "h1", attributes: {}, childNodes: [{ type: 3, id: 7, textContent: "Render me" }] },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  const mouseMove = { type: 3, timestamp: startMs + 600, data: { source: 1, positions: [{ x: 100, y: 100, id: 5, timeOffset: 0 }] } };
  const textChange = { type: 3, timestamp: startMs + 1200, data: { source: 0, texts: [{ id: 7, value: "Rendered" }], attributes: [], removes: [], adds: [] } };
  // Optional extra activity so a render takes a while (e.g. to test the concurrency limit).
  const extra = [];
  for (let t = 1500; t < (options.durationMs ?? 0); t += 500) {
    extra.push({ type: 3, timestamp: startMs + t, data: { source: 1, positions: [{ x: 100 + (t % 300), y: 100, id: 5, timeOffset: 0 }] } });
  }
  return options.withFullSnapshot ? [meta, fullSnapshot, mouseMove, textChange, ...extra] : [meta, mouseMove];
}

async function uploadTab(browserSessionId: string, startMs: number, options: { withFullSnapshot: boolean, durationMs?: number }) {
  const segmentId = randomUUID();
  const upload = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: browserSessionId,
      session_replay_segment_id: segmentId,
      batch_id: randomUUID(),
      started_at_ms: startMs,
      sent_at_ms: startMs + Math.max(2000, options.durationMs ?? 0),
      events: rrwebEvents(startMs, options),
    },
  });
  if (upload.status !== 200) throw new Error(`Batch upload failed: ${JSON.stringify(upload.body)}`);
  return { replayId: upload.body.session_replay_id as string, segmentId };
}

/** Records a replay with one tab per entry of `tabStartOffsetsMs`, all in the same session. */
async function recordReplay(options: { withFullSnapshot: boolean, tabStartOffsetsMs?: number[], durationMs?: number }) {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();
  const startMs = Date.now() - 20_000 - (options.durationMs ?? 0);
  const browserSessionId = randomUUID();
  const tabs = [];
  for (const offset of options.tabStartOffsetsMs ?? [0]) {
    tabs.push(await uploadTab(browserSessionId, startMs + offset, options));
  }
  if (new Set(tabs.map((t) => t.replayId)).size !== 1) throw new Error("Tabs landed in different replays");
  return { replayId: tabs[0].replayId, segmentIds: tabs.map((t) => t.segmentId) };
}

async function waitForRender(replayId: string, renderId: string) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS - 10_000;
  while (true) {
    const res = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders/${renderId}`, { accessType: "server" });
    if (res.status !== 200) throw new Error(`Polling render failed: ${JSON.stringify(res.body)}`);
    if (res.body.status === "succeeded" || res.body.status === "failed") return res;
    if (Date.now() > deadline) throw new Error(`Render still ${res.body.status} after waiting`);
    await wait(1000);
  }
}

it("renders a session replay to a downloadable MP4", async ({ expect }) => {
  const { replayId } = await recordReplay({ withFullSnapshot: true });

  const create = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: { fps: 10, speed: 2 },
  });
  expect(create.status).toBe(200);
  expect(create.body).toMatchObject({
    session_replay_id: replayId,
    // All tabs is the default.
    session_replay_segment_id: null,
    status: "rendering",
    options: { fps: 10, speed: 2, skip_inactivity: true },
    video: null,
  });

  const done = await waitForRender(replayId, create.body.id);
  expect(done.body).toMatchObject({
    status: "succeeded",
    progress: 1,
    error_message: null,
    video: { width: 640, height: 480 },
  });
  expect(done.body.video.byte_length).toBeGreaterThan(0);
  expect(done.body.video.duration_ms).toBeGreaterThan(0);

  const video = await fetch(done.body.video.url);
  expect(video.status).toBe(200);
  const bytes = new Uint8Array(await video.arrayBuffer());
  expect(bytes.byteLength).toBe(done.body.video.byte_length);
  expect(Buffer.from(bytes.subarray(4, 8)).toString("latin1")).toBe("ftyp");

  const list = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, { accessType: "server" });
  expect(list.status).toBe(200);
  expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([create.body.id]);
}, RENDER_TIMEOUT_MS);

it("renders every tab by default, and a single tab on request", async ({ expect }) => {
  // Two tabs with a gap between them: the all-tabs video covers both.
  const { replayId, segmentIds } = await recordReplay({ withFullSnapshot: true, tabStartOffsetsMs: [0, 4000] });

  const all = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: { fps: 10, skip_inactivity: false },
  });
  expect(all.status).toBe(200);
  expect(all.body.session_replay_segment_id).toBe(null);
  const allDone = await waitForRender(replayId, all.body.id);
  expect(allDone.body.status).toBe("succeeded");

  const single = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: { fps: 10, skip_inactivity: false, session_replay_segment_id: segmentIds[1] },
  });
  expect(single.status).toBe(200);
  expect(single.body.session_replay_segment_id).toBe(segmentIds[1]);
  const singleDone = await waitForRender(replayId, single.body.id);
  expect(singleDone.body.status).toBe("succeeded");

  // Each tab records ~1.2s; the all-tabs video adds the other tab plus the
  // fast-forwarded gap between them, so it is clearly longer.
  expect(allDone.body.video.duration_ms).toBeGreaterThan(singleDone.body.video.duration_ms + 1000);
}, RENDER_TIMEOUT_MS * 2);

it("reports a failed render with a readable reason", async ({ expect }) => {
  const { replayId } = await recordReplay({ withFullSnapshot: false });

  const create = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: {},
  });
  expect(create.status).toBe(200);

  const done = await waitForRender(replayId, create.body.id);
  expect(done.body).toMatchObject({
    status: "failed",
    video: null,
    error_message: "The replay has no full snapshot, so there is nothing to render.",
  });
}, RENDER_TIMEOUT_MS);

it("validates the replay, segment and options", async ({ expect }) => {
  const { replayId } = await recordReplay({ withFullSnapshot: true });

  const unknownReplay = await niceBackendFetch(`/api/v1/session-replays/${randomUUID()}/renders`, {
    method: "POST",
    accessType: "server",
    body: {},
  });
  expect(unknownReplay.status).toBe(404);

  const unknownSegment = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: { session_replay_segment_id: randomUUID() },
  });
  expect(unknownSegment.status).toBe(400);
  expect(unknownSegment.body).toContain("no segment with that session_replay_segment_id");

  const badFps = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "server",
    body: { fps: 120 },
  });
  expect(badFps.status).toBe(400);

  const unknownRender = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders/${randomUUID()}`, { accessType: "server" });
  expect(unknownRender.status).toBe(404);
});

it("is not available to client access", async ({ expect }) => {
  const { replayId } = await recordReplay({ withFullSnapshot: true });
  const res = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
    method: "POST",
    accessType: "client",
    body: {},
  });
  expect(res.status).toBe(401);
  expect(res.body.code).toBe("INSUFFICIENT_ACCESS_TYPE");
});

it("limits concurrent renders per project with a known error", async ({ expect }) => {
  // Long enough (30fps, no idle skipping) that the first renders are still running.
  const { replayId } = await recordReplay({ withFullSnapshot: true, durationMs: 15_000 });
  const statuses: number[] = [];
  let lastBody: unknown = null;
  for (let i = 0; i < 4; i++) {
    const res = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, {
      method: "POST",
      accessType: "server",
      body: { fps: 30, skip_inactivity: false },
    });
    statuses.push(res.status);
    lastBody = res.body;
  }
  expect(statuses).toEqual([200, 200, 200, 409]);
  expect(lastBody).toMatchObject({ code: "SESSION_REPLAY_RENDER_LIMIT_REACHED", details: { limit: 3 } });
}, RENDER_TIMEOUT_MS);

it("only exposes a render under its own replay and project", async ({ expect }) => {
  const { replayId } = await recordReplay({ withFullSnapshot: true });
  const render = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, { method: "POST", accessType: "server", body: {} });
  expect(render.status).toBe(200);

  // Same project, different replay id in the path (a second user, so a second replay).
  await Auth.fastSignUp();
  const { replayId: otherReplayId } = await (async () => {
    const browserSessionId = randomUUID();
    const startMs = Date.now() - 5_000;
    const upload = await niceBackendFetch("/api/v1/session-replays/batch", {
      method: "POST",
      accessType: "client",
      body: {
        browser_session_id: browserSessionId,
        session_replay_segment_id: randomUUID(),
        batch_id: randomUUID(),
        started_at_ms: startMs,
        sent_at_ms: startMs + 2000,
        events: rrwebEvents(startMs, { withFullSnapshot: true }),
      },
    });
    return { replayId: upload.body.session_replay_id as string };
  })();
  expect(otherReplayId).not.toBe(replayId);
  const wrongReplay = await niceBackendFetch(`/api/v1/session-replays/${otherReplayId}/renders/${render.body.id}`, { accessType: "server" });
  expect(wrongReplay.status).toBe(404);

  // Client access can't read renders.
  const client = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, { accessType: "client" });
  expect(client.status).toBe(401);

  // Another project's server key sees neither the replay nor the render.
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const otherProjectList = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders`, { accessType: "server" });
  expect(otherProjectList.status).toBe(404);
  const otherProjectGet = await niceBackendFetch(`/api/v1/session-replays/${replayId}/renders/${render.body.id}`, { accessType: "server" });
  expect(otherProjectGet.status).toBe(404);
});

it("returns 404 when listing renders of an unknown replay", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const res = await niceBackendFetch(`/api/v1/session-replays/${randomUUID()}/renders`, { accessType: "server" });
  expect(res.status).toBe(404);
  expect(res.body.code).toBe("ITEM_NOT_FOUND");
});
