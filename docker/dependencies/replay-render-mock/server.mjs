// Local stand-in for "a Freestyle VM booted from the replay-render snapshot".
//
// The backend's mock runtime (apps/backend/src/lib/session-replay-renders/
// runtime-mock.ts) talks to this instead of Freestyle when STACK_FREESTYLE_API_KEY
// is the mock key. It runs the exact same renderer — apps/backend/scripts/
// replay-render/render.mjs, mounted read-only at /app/render.mjs — with the same
// params.json contract, so mock and real renders differ only in where the
// process runs.
//
//   POST   /jobs      { params }  -> { id }
//   GET    /jobs/:id              -> { state, exit_code, progress, result, log }
//   DELETE /jobs/:id              -> 204
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const PORT = 8080;
const HOST_ON_HOST = process.env.HOST_ON_HOST || "host.docker.internal";
const MAX_JOBS = Number(process.env.REPLAY_RENDER_MOCK_MAX_JOBS || 8);
const JOB_TTL_MS = 30 * 60_000;
const LOG_LIMIT = 20_000;
const JOBS_DIR = "/tmp/jobs";

/** @type {Map<string, { dir: string, child: import("node:child_process").ChildProcess, exitCode: number | null, createdAt: number, log: string }>} */
const jobs = new Map();

// Presigned URLs from the local S3 mock, and the backend's callback URL, point
// at the host's localhost, which inside this container is the container itself.
function rewriteHostUrl(value) {
  const url = new URL(value);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = HOST_ON_HOST;
  return url.toString();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function startJob(params) {
  const validTabs = Array.isArray(params?.tabs) && params.tabs.every((tab) => Array.isArray(tab?.chunks) && tab.chunks.every((c) => typeof c?.url === "string"));
  const urlFields = ["upload_url", "result_upload_url", "callback_url"];
  if (!validTabs || urlFields.some((field) => typeof params[field] !== "string")) {
    throw Object.assign(new Error(`params.tabs[].chunks[].url and params.${urlFields.join("/")} are required`), { statusCode: 400 });
  }
  const running = [...jobs.values()].filter((job) => job.exitCode == null).length;
  if (running >= MAX_JOBS) {
    throw Object.assign(new Error(`Too many renders in progress (${running})`), { statusCode: 429 });
  }
  const id = randomUUID();
  const dir = `${JOBS_DIR}/${id}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/params.json`, JSON.stringify({
    ...params,
    tabs: params.tabs.map((tab) => ({ ...tab, chunks: tab.chunks.map((c) => ({ ...c, url: rewriteHostUrl(c.url) })) })),
    upload_url: rewriteHostUrl(params.upload_url),
    result_upload_url: rewriteHostUrl(params.result_upload_url),
    // The backend's own callback URL is localhost too when it runs on the host.
    callback_url: rewriteHostUrl(params.callback_url),
  }));
  const child = spawn("node", ["/app/render.mjs", dir], { cwd: "/app", stdio: ["ignore", "pipe", "pipe"] });
  const job = { dir, child, exitCode: null, createdAt: Date.now(), log: "" };
  const appendLog = (chunk) => {
    job.log = (job.log + chunk).slice(-LOG_LIMIT);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.on("close", (code) => {
    job.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    appendLog(`spawn failed: ${error.message}\n`);
    job.exitCode = 1;
  });
  jobs.set(id, job);
  return id;
}

/**
 * Stops a job and removes its files without waiting for it: the backend
 * disposes a job while finishing it from that job's own callback, which the
 * job is still waiting on.
 */
function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  const cleanup = () => {
    rm(job.dir, { recursive: true, force: true }).catch((error) => console.error("cleanup failed", id, error));
  };
  if (job.exitCode != null) {
    cleanup();
    return;
  }
  // Puppeteer starts Chrome in its own process group and closes it on
  // SIGTERM (handleSIGTERM); SIGKILL right away would orphan Chrome.
  job.child.once("close", cleanup);
  job.child.kill("SIGTERM");
  setTimeout(() => {
    if (job.exitCode == null) job.child.kill("SIGKILL");
  }, 5000).unref();
}

setInterval(() => {
  for (const [id, job] of jobs) {
    if (Date.now() - job.createdAt > JOB_TTL_MS) {
      deleteJob(id);
    }
  }
}, 60_000).unref();

function send(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const jobMatch = url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/);
    if (request.method === "GET" && url.pathname === "/health") {
      return send(response, 200, { ok: true, jobs: jobs.size });
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(request);
      return send(response, 201, { id: await startJob(body.params) });
    }
    if (jobMatch && request.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(response, 404, { error: "Job not found" });
      return send(response, 200, {
        state: job.exitCode == null ? "running" : "exited",
        exit_code: job.exitCode,
        progress: await readJson(`${job.dir}/progress.json`),
        result: job.exitCode == null ? null : await readJson(`${job.dir}/result.json`),
        log: job.log.slice(-4000),
      });
    }
    if (jobMatch && request.method === "DELETE") {
      deleteJob(jobMatch[1]);
      return send(response, 204);
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, error.statusCode ?? 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`replay-render-mock listening on ${PORT}`);
});
