// Session replay → MP4 renderer.
//
// Runs as an unprivileged user in a single-use Freestyle VM booted from the
// replay-render snapshot (see bootstrap-replay-render-snapshot.ts), and in the
// local replay-render-mock container. Usage:
//
//   node render.mjs <job-dir>
//
// <job-dir>/params.json (written by the backend, data only):
//   events_urls          presigned GETs, one per stored chunk of ONE replay segment
//   upload_url           presigned PUT for the finished video (Content-Type video/mp4)
//   fps, speed, skip_inactivity, max_output_seconds
//
// Writes <job-dir>/progress.json while rendering and <job-dir>/result.json when
// done. The VM holds no credentials: everything it can reach is those URLs.
//
// Frames are deterministic: every output frame advances the rrweb Replayer to
// an exact offset and screenshots it, so a slow machine renders slower rather
// than dropping frames.
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import puppeteer from "puppeteer";

const require = createRequire(import.meta.url);
const RRWEB_JS = require.resolve("rrweb/dist/rrweb.min.js");
const RRWEB_CSS = require.resolve("rrweb/dist/rrweb.min.css");

const MAX_EVENTS_BYTES = 256 * 1024 * 1024;
const IDLE_THRESHOLD_MS = 2000;

const jobDir = process.argv[2];
const startedAt = Date.now();
const warnings = [];

async function main() {
  const params = JSON.parse(await readFile(`${jobDir}/params.json`, "utf8"));
  const fps = clamp(params.fps ?? 15, 1, 30);
  const speed = clamp(params.speed ?? 1, 0.25, 8);
  const idleThresholdMs = params.skip_inactivity === false ? Infinity : IDLE_THRESHOLD_MS;
  const maxOutputSeconds = clamp(params.max_output_seconds ?? 600, 1, 1800);

  const events = await loadEvents(params.events_urls);
  if (events.length === 0) throw new RenderError("The replay has no events to render.");
  events.sort((a, b) => a.timestamp - b.timestamp);
  if (!events.some((e) => e.type === 2)) throw new RenderError("The replay has no full snapshot, so there is nothing to render.");

  const meta = events.find((e) => e.type === 4)?.data ?? {};
  const width = even(clamp(meta.width ?? 1280, 320, 1920));
  const height = even(clamp(meta.height ?? 720, 240, 1200));
  const frameOffsets = buildFrameOffsets(events, { fps, speed, idleThresholdMs, maxFrames: Math.floor(maxOutputSeconds * fps) });

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
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}.replayer-wrapper{position:relative}</style></head><body></body></html>`);
    await page.addStyleTag({ path: RRWEB_CSS });
    await page.addScriptTag({ path: RRWEB_JS });

    // replayer.pause(t)/play(t) are never used: in rrweb 1.1.3 a forward seek
    // re-applies mutations it has already applied (lastPlayedEvent is not
    // advanced for synchronously applied events), duplicating DOM nodes on
    // every frame. Each event is cast exactly once, in order, through rrweb's
    // own synchronous cast function instead.
    await page.evaluate(async (evs) => {
      // eslint-disable-next-line no-undef
      const replayer = new rrweb.Replayer(evs, {
        root: document.body,
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
      const all = replayer.service.state.context.events;
      const t0 = all[0].timestamp;
      let next = 0;
      window.__advanceTo = (offset) => {
        const before = next;
        while (next < all.length && all[next].timestamp - t0 <= offset) {
          replayer.getCastFn(all[next], true)();
          next++;
        }
        // Synchronous casts queue DOM mutations; rrweb applies them on "flush",
        // which its own seek path emits after each synchronous batch.
        if (next !== before) replayer.emitter.emit("flush");
      };
      window.__advanceTo(0);
    }, events);
    // Give fonts and images referenced by the first snapshot a chance to load.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => warnings.push("Some page assets were still loading after 8s."));

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
    const ffmpegDone = new Promise((resolve, reject) => {
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr}`)));
    });

    let lastProgressWrite = 0;
    for (let i = 0; i < frameOffsets.length; i++) {
      await page.evaluate((offset) => window.__advanceTo(offset), frameOffsets[i]);
      const jpeg = await page.screenshot({ type: "jpeg", quality: 85, optimizeForSpeed: true });
      if (!ffmpeg.stdin.write(jpeg)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
      if (Date.now() - lastProgressWrite > 1000) {
        lastProgressWrite = Date.now();
        await writeFile(`${jobDir}/progress.json`, JSON.stringify({ frame: i + 1, total: frameOffsets.length }));
      }
    }
    ffmpeg.stdin.end();
    await ffmpegDone;
    await writeFile(`${jobDir}/progress.json`, JSON.stringify({ frame: frameOffsets.length, total: frameOffsets.length }));

    const video = await readFile(outPath);
    const res = await fetch(params.upload_url, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: video,
    });
    if (!res.ok) throw new RenderError(`Uploading the video failed with HTTP ${res.status}.`);

    await writeResult({
      status: "ok",
      width,
      height,
      fps,
      frame_count: frameOffsets.length,
      replay_duration_ms: events.at(-1).timestamp - events[0].timestamp,
      output_duration_ms: Math.round(frameOffsets.length / fps * 1000),
      output_bytes: (await stat(outPath)).size,
      failed_requests: failedRequests,
      failed_origins: [...failedOrigins].slice(0, 20),
      render_ms: Date.now() - startedAt,
      warnings,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

class RenderError extends Error {}

async function loadEvents(urls) {
  if (!Array.isArray(urls) || urls.length === 0) throw new RenderError("No replay chunks to render.");
  const events = [];
  let totalBytes = 0;
  for (const url of urls) {
    const res = await fetch(url);
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
  return events;
}

// Offsets (ms after the first event) to advance to, one per output frame. With
// skip-inactivity, gaps longer than idleThresholdMs are cut to about a second.
function buildFrameOffsets(events, { fps, speed, idleThresholdMs, maxFrames }) {
  const t0 = events[0].timestamp;
  const end = events.at(-1).timestamp - t0 + 500;
  const step = (1000 / fps) * speed;
  const times = events.map((e) => e.timestamp - t0);
  const offsets = [];
  let t = 0;
  let next = 0;
  while (t <= end && offsets.length < maxFrames) {
    offsets.push(Math.round(t));
    t += step;
    while (next < times.length && times[next] <= t) next++;
    const prev = next > 0 ? times[next - 1] : 0;
    if (next < times.length && times[next] - prev > idleThresholdMs && t > prev + 500 && t < times[next] - 500) {
      t = times[next] - 500;
    }
  }
  return offsets;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

function even(n) {
  return Math.floor(n / 2) * 2;
}

async function writeResult(result) {
  await writeFile(`${jobDir}/result.json`, JSON.stringify(result));
}

main().catch(async (error) => {
  // Only RenderError messages are shown to users; anything else is an
  // internal failure whose details stay in the log.
  const userMessage = error instanceof RenderError ? error.message : "The renderer failed unexpectedly.";
  console.error(error);
  await writeResult({ status: "error", error: userMessage, render_ms: Date.now() - startedAt, warnings });
  process.exit(1);
});
