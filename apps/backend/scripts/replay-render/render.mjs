// Session replay → MP4 renderer.
//
// Runs as an unprivileged user in a single-use Freestyle VM booted from the
// replay-render snapshot (see bootstrap-replay-render-snapshot.ts), and in the
// local replay-render-mock container. Usage:
//
//   node render.mjs <job-dir>
//
// <job-dir>/params.json (written by the backend, data only):
//   tabs: [{ tab_key, label_index, chunks: [{ url, first_event_at_ms, last_event_at_ms }] }]
//     the replay's tabs (segments) to render, each chunk as a presigned GET
//   upload_url           presigned PUT for the finished video (Content-Type video/mp4)
//   result_upload_url    presigned PUT for result.json (Content-Type application/json)
//   callback_url, callback_token
//                        POSTed (Bearer callback_token) once the result is uploaded
//   fps, speed, skip_inactivity, max_output_seconds
//
// Writes <job-dir>/progress.json while rendering. When done — success or
// failure — it writes result.json, uploads it, and calls back, so the backend
// learns the outcome right away and still finds it after this machine is gone
// (it powers itself off when this process exits). The machine holds no
// credentials: everything it can reach is those URLs.
//
// With several tabs the video follows the active tab exactly like the dashboard
// player does: the rule lives in session-replay-timeline.ts, a verbatim copy of
// packages/shared/src/utils/session-replay-timeline.ts placed next to this file
// (Node runs it through its built-in TypeScript type stripping).
//
// Frames are deterministic: each output frame advances the shown tab's rrweb
// Replayer to an exact timestamp and screenshots it, so a slow machine renders
// slower rather than dropping frames.
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import puppeteer from "puppeteer";
import {
  INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER,
  computeReplayGlobalTimeline,
  decideReplayActiveTab,
  mergeReplayChunkRanges,
} from "./session-replay-timeline.ts";

const require = createRequire(import.meta.url);
const RRWEB_JS = require.resolve("rrweb/dist/rrweb.min.js");
const RRWEB_CSS = require.resolve("rrweb/dist/rrweb.min.css");

// Decompressed event JSON (fetch() inflates gzip-encoded chunks). Keep in line
// with maxRecordingBytes in apps/backend/src/lib/session-replay-renders, which
// caps the compressed size at admission; replay JSON compresses ~5-10x.
const MAX_EVENTS_BYTES = 512 * 1024 * 1024;
const EVENTS_PER_TRANSFER = 2000;
const CHUNK_FETCH_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const IDLE_THRESHOLD_MS = 2000;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;

const jobDir = process.argv[2];
const startedAt = Date.now();
const warnings = [];

async function main() {
  const params = JSON.parse(await readFile(`${jobDir}/params.json`, "utf8"));
  jobParams = params;
  const fps = clamp(params.fps ?? 15, 1, 30);
  const speed = clamp(params.speed ?? 1, 0.25, 8);
  const skipInactivity = params.skip_inactivity !== false;
  const maxOutputSeconds = clamp(params.max_output_seconds ?? 600, 1, 1800);

  const tabs = await loadTabs(params.tabs);
  const timeline = tabs.map((t) => ({
    tabKey: t.tabKey,
    labelIndex: t.labelIndex,
    ranges: t.ranges,
    hasFullSnapshot: t.hasFullSnapshot,
  }));
  if (!timeline.some((t) => t.hasFullSnapshot)) {
    throw new RenderError("The replay has no full snapshot, so there is nothing to render.");
  }

  const plan = buildFramePlan(tabs, timeline, {
    step: (1000 / fps) * speed,
    skipInactivity,
    maxFrames: Math.floor(maxOutputSeconds * fps),
    holdFrames: Math.round(fps / 2),
  });
  if (plan.length === 0) throw new RenderError("The replay has no frames to render.");
  const shownTabs = tabs.filter((t) => plan.some((f) => f.tabKey === t.tabKey));

  // One canvas for the whole video, big enough for the largest tab shown.
  const width = even(clamp(Math.max(...shownTabs.map((t) => t.width)), 320, MAX_WIDTH));
  const height = even(clamp(Math.max(...shownTabs.map((t) => t.height)), 240, MAX_HEIGHT));

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/chrome-headless-shell",
    headless: "shell",
    args: [
      "--hide-scrollbars", "--mute-audio", "--disable-gpu", "--font-render-hinting=none", "--disable-dev-shm-usage",
      // Only the local mock sets this; Freestyle VMs keep Chrome's own sandbox.
      ...(process.env.RENDER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
  });
  let failedRequests = 0;
  const failedOrigins = new Set();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.on("requestfailed", (req) => {
      failedRequests++;
      try {
        failedOrigins.add(new URL(req.url()).origin);
      } catch {
        // data:/blob: URLs have no useful origin
      }
    });
    await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; padding: 0; overflow: hidden; background: #111; }
      .tab { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; visibility: hidden; }
      .tab.active { visibility: visible; }
      .stage { transform-origin: center center; background: #fff; }
      .replayer-wrapper { position: relative; }
      #label { position: absolute; top: 12px; left: 12px; z-index: 10; padding: 4px 10px; border-radius: 6px;
        font: 600 14px/1.4 -apple-system, system-ui, sans-serif; color: #fff; background: rgba(17, 17, 17, 0.75); display: none; }
    </style></head><body><div id="label"></div></body></html>`);
    await page.addStyleTag({ path: RRWEB_CSS });
    await page.addScriptTag({ path: RRWEB_JS });

    // replayer.pause(t)/play(t) are never used: in rrweb 1.1.3 a forward seek
    // re-applies mutations it has already applied (lastPlayedEvent is not
    // advanced for synchronously applied events), duplicating DOM nodes on
    // every frame. Each event is cast exactly once, in order, through rrweb's
    // own synchronous cast function instead.
    await page.evaluate((canvas, tabInfo, showLabels) => {
      const tabsByKey = new Map(tabInfo.map((t) => [t.tabKey, t]));
      const players = new Map();
      const label = document.getElementById("label");
      let shownKey = null;

      async function getPlayer(tabKey) {
        const existing = players.get(tabKey);
        if (existing) return existing;
        const info = tabsByKey.get(tabKey);
        const container = document.createElement("div");
        container.className = "tab";
        // TODO: sized from the tab's first Meta event only. A window resized
        // mid-recording resizes rrweb's iframe but not this stage, so later
        // frames of that tab come out cropped or bordered.
        const stage = document.createElement("div");
        stage.className = "stage";
        stage.style.width = `${info.width}px`;
        stage.style.height = `${info.height}px`;
        stage.style.transform = `scale(${Math.min(1, canvas.width / info.width, canvas.height / info.height)})`;
        container.appendChild(stage);
        document.body.appendChild(container);
        // eslint-disable-next-line no-undef
        const replayer = new rrweb.Replayer(window.__events.get(tabKey), {
          root: stage,
          skipInactive: false,
          showWarning: false,
          showDebug: false,
          mouseTail: false,
          triggerFocus: false,
          // Keeps the replay iframe sandboxed without allow-scripts.
          UNSAFE_replayCanvas: false,
        });
        // Let the constructor's deferred first-snapshot rebuild run before casting.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const player = { container, replayer, events: replayer.service.state.context.events, next: 0 };
        players.set(tabKey, player);
        return player;
      }

      window.__render = async (tabKey, ts) => {
        const player = await getPlayer(tabKey);
        const before = player.next;
        while (player.next < player.events.length && player.events[player.next].timestamp <= ts) player.next++;
        if (player.next !== before) {
          // Exactly rrweb's own seek path: cast the new events synchronously
          // (which also moves the cursor to its last position), then "flush"
          // to apply the queued DOM mutations.
          player.replayer.applyEventsSynchronously(player.events.slice(before, player.next));
          player.replayer.emitter.emit("flush");
        }
        if (shownKey !== tabKey) {
          players.get(shownKey)?.container.classList.remove("active");
          player.container.classList.add("active");
          shownKey = tabKey;
          if (showLabels) {
            label.textContent = `Tab ${tabsByKey.get(tabKey).labelIndex}`;
            label.style.display = "block";
          }
        }
      };
    }, { width, height }, shownTabs.map((t) => ({ tabKey: t.tabKey, labelIndex: t.labelIndex, width: t.width, height: t.height })), shownTabs.length > 1);
    // Events go in separately and in batches, keeping each DevTools message
    // small; Node's copy is dropped once the page has them.
    await page.evaluate(() => {
      window.__events = new Map();
    });
    for (const tab of shownTabs) {
      await page.evaluate((key) => window.__events.set(key, []), tab.tabKey);
      for (let i = 0; i < tab.events.length; i += EVENTS_PER_TRANSFER) {
        await page.evaluate((key, batch) => window.__events.get(key).push(...batch), tab.tabKey, tab.events.slice(i, i + EVENTS_PER_TRANSFER));
      }
      tab.events = null;
    }

    const outPath = `${jobDir}/out.mp4`;
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-t", String(maxOutputSeconds),
      outPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegStderr = "";
    ffmpeg.stderr.on("data", (d) => {
      ffmpegStderr = (ffmpegStderr + d).slice(-4000);
    });
    let ffmpegExited = false;
    const ffmpegDone = new Promise((resolve, reject) => {
      ffmpeg.on("error", (error) => {
        ffmpegExited = true;
        reject(error);
      });
      ffmpeg.on("close", (code) => {
        ffmpegExited = true;
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr}`));
      });
    });
    // Observed below; this only keeps an early ffmpeg failure from being an
    // unhandled rejection that kills the process before result.json is written.
    ffmpegDone.catch(() => {});
    // Writing to a dead ffmpeg emits EPIPE on stdin; the close handler above reports it.
    ffmpeg.stdin.on("error", () => {});

    let lastProgressWrite = 0;
    let previousTabKey = null;
    let tabSwitches = 0;
    for (let i = 0; i < plan.length; i++) {
      const frame = plan[i];
      await page.evaluate((key, ts) => window.__render(key, ts), frame.tabKey, frame.ts);
      if (frame.tabKey !== previousTabKey) {
        if (previousTabKey !== null) tabSwitches++;
        previousTabKey = frame.tabKey;
        // A newly shown tab may reference fonts and images that are not loaded yet.
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => warnings.push("Some page assets were still loading after 5s."));
      }
      const jpeg = await page.screenshot({ type: "jpeg", quality: 85, optimizeForSpeed: true });
      if (ffmpegExited) await ffmpegDone; // throws ffmpeg's error
      if (!ffmpeg.stdin.write(jpeg)) {
        await Promise.race([new Promise((resolve) => ffmpeg.stdin.once("drain", resolve)), ffmpegDone]);
      }
      if (Date.now() - lastProgressWrite > 1000) {
        lastProgressWrite = Date.now();
        await writeFile(`${jobDir}/progress.json`, JSON.stringify({ frame: i + 1, total: plan.length }));
      }
    }
    ffmpeg.stdin.end();
    await ffmpegDone;
    await writeFile(`${jobDir}/progress.json`, JSON.stringify({ frame: plan.length, total: plan.length }));

    const video = await readFile(outPath);
    const res = await fetch(params.upload_url, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: video,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new RenderError(`Uploading the video failed with HTTP ${res.status}.`);

    const { globalTotalMs } = computeReplayGlobalTimeline(tabs);
    await finishJob(params, {
      status: "ok",
      width,
      height,
      fps,
      frame_count: plan.length,
      tab_count: shownTabs.length,
      tab_switches: tabSwitches,
      replay_duration_ms: globalTotalMs,
      output_duration_ms: Math.round(plan.length / fps * 1000),
      output_bytes: (await stat(outPath)).size,
      failed_requests: failedRequests,
      failed_origins: [...failedOrigins].slice(0, 20),
      render_ms: Date.now() - startedAt,
      warnings: [...new Set(warnings)],
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

class RenderError extends Error {}

/**
 * Plans every output frame up front: the timestamp to show and which tab shows
 * it. The tab follows decideReplayActiveTab, the dashboard player's own rule.
 */
function buildFramePlan(tabs, timeline, { step, skipInactivity, maxFrames, holdFrames }) {
  const tabsByKey = new Map(tabs.map((t) => [t.tabKey, t]));
  const plan = [];
  let ts = computeReplayGlobalTimeline(tabs).globalStartTs;
  let active = null;
  while (plan.length < maxFrames) {
    const decision = decideReplayActiveTab(timeline, active, ts);
    if (decision.type === "end") break;
    if (decision.type === "switch") {
      active = decision.tabKey;
    } else if (decision.type === "gap" && decision.tabKey === active) {
      // A pause in the shown tab's own recording with nothing else recording:
      // the player just keeps playing this tab, so the video does too.
      plan.push({ ts, tabKey: active });
      ts += step;
      if (skipInactivity) ts = Math.max(ts, decision.startTs);
      continue;
    } else if (decision.type === "gap") {
      if (skipInactivity || active == null) {
        ts = decision.startTs;
        active = decision.tabKey;
        continue;
      }
      // Like the player: hold the last tab while fast-forwarding to the next one.
      plan.push({ ts, tabKey: active });
      ts = Math.min(decision.startTs, ts + step * INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER);
      continue;
    }
    plan.push({ ts, tabKey: active });
    ts += step;
    if (skipInactivity) ts = skipIdle(tabsByKey.get(active), ts);
  }
  // Hold the last frame for half a second so the video doesn't end on a cut.
  const last = plan.at(-1);
  if (last != null) {
    for (let i = 0; i < holdFrames && plan.length < maxFrames; i++) plan.push(last);
  }
  return plan;
}

/**
 * Within the shown tab, cuts idle stretches longer than IDLE_THRESHOLD_MS down
 * to about a second — but never past the end of the tab's current recording
 * range, where the shared rule may hand over to another tab.
 */
function skipIdle(tab, ts) {
  const times = tab.eventTimes;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0 || lo >= times.length) return ts;
  const prev = times[lo - 1];
  const next = times[lo];
  if (next - prev <= IDLE_THRESHOLD_MS || ts <= prev + 500 || ts >= next - 500) return ts;
  const range = tab.ranges.find((r) => r.startTs <= ts && ts <= r.endTs);
  const limit = range == null ? next - 500 : Math.min(next - 500, range.endTs + 1);
  return Math.max(ts, limit);
}

async function loadTabs(paramTabs) {
  if (!Array.isArray(paramTabs) || paramTabs.length === 0) throw new RenderError("No replay tabs to render.");
  let totalBytes = 0;
  const tabs = [];
  for (const paramTab of paramTabs) {
    const events = [];
    for (const chunk of paramTab.chunks) {
      const res = await fetch(chunk.url, { signal: AbortSignal.timeout(CHUNK_FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new RenderError(`Downloading a replay chunk failed with HTTP ${res.status}.`);
      const raw = Buffer.from(await res.arrayBuffer());
      totalBytes += raw.byteLength;
      if (totalBytes > MAX_EVENTS_BYTES) throw new RenderError("The replay is too large to render.");
      // Chunks are stored gzipped; fetch() already inflated them if the object
      // was served with Content-Encoding: gzip.
      const body = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
      const chunkEvents = Array.isArray(body) ? body : body.events;
      if (!Array.isArray(chunkEvents)) throw new RenderError("A replay chunk is malformed.");
      for (const event of chunkEvents) {
        if (typeof event === "object" && event !== null && typeof event.timestamp === "number" && typeof event.type === "number") {
          events.push(event);
        }
      }
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    const chunkSpans = paramTab.chunks.map((c) => ({ firstEventAtMs: c.first_event_at_ms, lastEventAtMs: c.last_event_at_ms }));
    const meta = events.find((e) => e.type === 4)?.data ?? {};
    tabs.push({
      tabKey: paramTab.tab_key,
      labelIndex: paramTab.label_index,
      events,
      eventTimes: events.map((e) => e.timestamp),
      // Like the player, the timeline comes from chunk metadata, not the events.
      ranges: mergeReplayChunkRanges(chunkSpans),
      firstEventAtMs: Math.min(...chunkSpans.map((c) => c.firstEventAtMs)),
      lastEventAtMs: Math.max(...chunkSpans.map((c) => c.lastEventAtMs)),
      hasFullSnapshot: events.some((e) => e.type === 2),
      width: clamp(meta.width ?? 1280, 320, 4096),
      height: clamp(meta.height ?? 720, 240, 4096),
    });
  }
  return tabs;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

function even(n) {
  return Math.floor(n / 2) * 2;
}

/**
 * Records the outcome locally, uploads it, then tells the backend to look.
 * Upload and callback are retried; if the callback still fails, the backend
 * finds the uploaded result on its next status read instead.
 */
async function finishJob(params, result) {
  await writeFile(`${jobDir}/result.json`, JSON.stringify(result));
  if (params == null) return;
  await withRetries("result upload", async () => {
    const res = await fetch(params.result_upload_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
  await withRetries("callback", async () => {
    const res = await fetch(params.callback_url, {
      method: "POST",
      headers: { authorization: `Bearer ${params.callback_token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

async function withRetries(label, fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      console.error(`${label} failed (attempt ${attempt}/5):`, error?.message ?? error);
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

let jobParams = null;
main().catch(async (error) => {
  // Only RenderError messages are shown to users; anything else is an
  // internal failure whose details stay in the log.
  const userMessage = error instanceof RenderError ? error.message : "The renderer failed unexpectedly.";
  console.error(error);
  await finishJob(jobParams, { status: "error", error: userMessage, render_ms: Date.now() - startedAt, warnings });
  process.exit(1);
});
