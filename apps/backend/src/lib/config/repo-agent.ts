/**
 * Dashboard -> GitHub config write, full-repo-in-a-sandbox edition.
 *
 * A Claude agent edits the WHOLE repo (config can span files), not just the config
 * file; we skip in-sandbox validation since the linked repo's GitHub Action
 * re-validates on push. Vercel Sandbox can't boot a custom image, so we warm-boot
 * from one SHARED, repo-independent base snapshot (agent runtime only, never a repo
 * or token; build via scripts/config-agent/build-image.ts -> STACK_CONFIG_AGENT_BASE_SNAPSHOT_ID,
 * else cold-boot node24 + install the SDK inline) and take a FRESH shallow clone per write.
 *
 * The sandbox is short-lived: it exists only to run the agent and CAPTURE the change
 * as a unified diff plus the base commit it was made against. As soon as that is
 * captured the sandbox is stopped — the review window is then unbounded and free
 * (nothing is kept alive). On confirm, `commitConfigUpdate` rebuilds the file contents
 * by applying the stored diff onto the exact base files (fetched from GitHub) and
 * commits via the git data REST API, so a slow reviewer, a closed tab, or a crashed
 * browser can never strand a running sandbox.
 *
 * Token discipline: a fresh token is fetched per boot/commit (GithubTokenProvider).
 * In the sandbox it is injected only into the clone remote URL (never the agent's env),
 * redacted from thrown errors, and never snapshotted. At commit time it is sent only as
 * an `Authorization` header to api.github.com, never persisted.
 */

import { buildCompleteConfigAgentPrompt, CONFIG_AGENT_REPO_TOOLS } from "@hexclave/shared-backend/config-agent";
import type { NormalizedConfig } from "@hexclave/shared/dist/config/format";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { Sandbox } from "@vercel/sandbox";
import { applyPatch, parsePatch } from "diff";
import { PRODUCTION_AI_PROXY_BASE_URL } from "../ai/proxy-url";

const AGENT_SDK_VERSION = "0.2.73";
const BASE = "/vercel/sandbox";
const REPO_DIR = `${BASE}/repo`;
const TOOLS_DIR = BASE; // agent SDK + runner live here, separate from the repo
const DEFAULT_AGENT_MODEL = "anthropic/claude-haiku-4.5";
const SANDBOX_TIMEOUT_MS = 900_000;
// Cap on the unified diff we persist (it is authoritative for the deferred commit, so
// it is never truncated — instead an oversized change fails at capture time). Config
// diffs are tiny; this only guards against a pathological agent rewriting the repo.
const MAX_CONFIG_DIFF_BYTES = 1_000_000;
const GIT_BOT_NAME = "Hexclave Config Bot";
const GIT_BOT_EMAIL = "config-bot@hexclave.com";

export type GithubRepoRef = { owner: string, repo: string, branch: string };

/**
 * Stages reported via `onStage` while a run is `running`. `awaiting_review` is
 * deliberately excluded — it is set separately, outside the staged progress.
 */
export type ConfigAgentInFlightStage = "initializing_sandbox" | "cloning_repo" | "agent_making_changes";

/**
 * Supplies a GitHub token at the moment it is needed (sandbox boot for clone, or
 * commit time for the REST push) instead of capturing a single token for the whole
 * flow, so a long-lived run always picks up the freshest token the caller can produce
 * (the dashboard refetches the user's OAuth token per request).
 */
export type GithubTokenProvider = () => Promise<string>;

/**
 * The lightweight change capture persisted for a deferred commit: the unified diff
 * the agent produced and the commit it was made against. The diff doubles as the
 * dashboard's review render and the commit source (applied onto the base on confirm).
 */
export type CapturedChange = { diff: string, baseSha: string };

export type ConfigUpdateCommitResult = { mode: "commit-to-branch", branch: string, commitUrl: string, commitSha: string };
export const CONFIG_REPO_COMMIT_CONFLICT_SAFE_ERROR = "The GitHub branch changed before the config commit could be pushed. Retry the update to apply the same changes on the latest branch.";

export class ConfigRepoAgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRepoAgentError";
  }
}

export class ConfigRepoCommitConflictError extends ConfigRepoAgentError {
  constructor(options?: { cause?: unknown }) {
    super(CONFIG_REPO_COMMIT_CONFLICT_SAFE_ERROR, options);
    this.name = "ConfigRepoCommitConflictError";
  }
}

// ---------------------------------------------------------------------------
// Sandbox credentials + low-level command helpers
// ---------------------------------------------------------------------------

type SandboxCreds = { teamId?: string, projectId?: string, token: string };

function sandboxCreds(): SandboxCreds {
  const token = getEnvVariable("STACK_VERCEL_SANDBOX_TOKEN", "");
  if (!token || token === "vercel_sandbox_disabled_for_local_development") {
    throw new ConfigRepoAgentError("Vercel Sandbox is not configured (STACK_VERCEL_SANDBOX_TOKEN); the config agent cannot run.");
  }
  return {
    teamId: getEnvVariable("STACK_VERCEL_SANDBOX_TEAM_ID", "") || undefined,
    projectId: getEnvVariable("STACK_VERCEL_SANDBOX_PROJECT_ID", "") || undefined,
    token,
  };
}

async function getConfigAgentSandbox(sandboxId: string, signal: AbortSignal): Promise<Sandbox> {
  const creds = sandboxCreds();
  return await Sandbox.get({ sandboxId, token: creds.token, teamId: creds.teamId, projectId: creds.projectId, signal });
}

async function stopSandboxWithContext(sandboxId: string, context: string): Promise<void> {
  // One request-independent budget covers lookup plus stop. It is shorter than
  // the standalone background-task drain, so shutdown cannot outlive PID 1.
  const cleanupSignal = AbortSignal.timeout(5000);
  try {
    const sandbox = await getConfigAgentSandbox(sandboxId, cleanupSignal);
    await sandbox.stop({ signal: cleanupSignal });
  } catch (error) {
    captureError(context, error);
  }
}

async function reportConfigAgentProgress(onProgress: AgentProgressSink | undefined, progress: string, context: string): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(progress);
  } catch (error) {
    captureError(context, error);
  }
}

async function reportConfigAgentStage(
  onStage: ((stage: ConfigAgentInFlightStage) => Promise<void>) | undefined,
  stage: ConfigAgentInFlightStage,
): Promise<void> {
  if (!onStage) return;
  try {
    await onStage(stage);
  } catch (error) {
    captureError("config-repo-agent-stage", error);
  }
}

/**
 * Strip any tokenized remote URL (`https://x-access-token:<token>@github.com/...`)
 * out of a string before it can be thrown, captured, persisted, or logged. The
 * clone command passes the tokenized URL as an argv, and git can echo the remote
 * URL in its errors — without this the dashboard user's OAuth token could leak
 * into the persisted run's `error` or Sentry.
 */
function redactTokens(text: string): string {
  return text.replace(/x-access-token:[^@\s/]+@/g, "x-access-token:***@");
}

type RunResult = { exitCode: number, stdout: string, stderr: string };

async function runRaw(sandbox: Sandbox, cmd: string, args: string[], opts?: { cwd?: string, env?: Record<string, string>, sudo?: boolean }): Promise<RunResult> {
  const finished = await sandbox.runCommand({ cmd, args, ...opts });
  const [stdout, stderr] = await Promise.all([
    finished.stdout().catch(() => ""),
    finished.stderr().catch(() => ""),
  ]);
  return { exitCode: finished.exitCode, stdout, stderr };
}

async function run(sandbox: Sandbox, cmd: string, args: string[], opts?: { cwd?: string, env?: Record<string, string>, sudo?: boolean }): Promise<RunResult> {
  const r = await runRaw(sandbox, cmd, args, opts);
  if (r.exitCode !== 0) {
    throw new ConfigRepoAgentError(redactTokens(`Command failed (exit ${r.exitCode}): ${cmd} ${args.join(" ")}\n${(r.stderr || r.stdout).slice(-1500)}`));
  }
  return r;
}

/**
 * Booting from a snapshot can leave `/etc/ssl/certs/ca-certificates.crt` empty,
 * which makes git/openssl fail with "error adding trust anchors" on any HTTPS
 * remote. Rebuilding the bundle from the (snapshot-captured) CA material fixes
 * it and needs no network. Best-effort — ignore failures on images without it.
 */
async function ensureTls(sandbox: Sandbox): Promise<void> {
  await runRaw(sandbox, "update-ca-certificates", [], { sudo: true });
}

// ---------------------------------------------------------------------------
// Git URLs (token injected only at call time, never persisted)
// ---------------------------------------------------------------------------

function tokenUrl(token: string, ref: Pick<GithubRepoRef, "owner" | "repo">): string {
  return `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
}

function tokenlessUrl(ref: Pick<GithubRepoRef, "owner" | "repo">): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Runner executed INSIDE the sandbox (no token in its env). Reads input from a
 * file and persists status to a file; process handlers catch the SDK's async errors. */
function buildRunnerScript(): string {
  return `
import { writeFileSync, readFileSync } from "fs";
const STATUS = ${JSON.stringify(`${TOOLS_DIR}/status.json`)};
const errs = [];
const status = (o) => { try { writeFileSync(STATUS, JSON.stringify({ ...o, stderr: errs.join("").slice(-4000) })); } catch {} };
process.on("uncaughtException", (e) => { status({ ok: false, error: "uncaught:" + String((e && e.stack) || e) }); process.exit(1); });
process.on("unhandledRejection", (e) => { status({ ok: false, error: "unhandledRejection:" + String((e && e.stack) || e) }); process.exit(1); });

// SANITIZED progress only: the tool action + a file BASENAME, never tool inputs,
// file contents, results, or assistant text — so no config secret or token can
// leak. Bash shows only the first two tokens (program + subcommand), so args
// (which could carry a token/secret) are never emitted. Written to a JSON file the
// orchestrator polls (robust across the sandbox boundary; no stdout/encoding deps).
const PROGRESS = ${JSON.stringify(`${TOOLS_DIR}/progress.json`)};
const recent = [];
const base = (p) => (typeof p === "string" ? (p.split("/").pop() || p) : "");
// In-sandbox live-feed cap: each line trimmed to 100 chars, keep last 6. Storage
// cap is separate (see recordConfigAgentRunProgress).
const emit = (s) => { recent.push(String(s).replace(/[\\r\\n]+/g, " ").slice(0, 100)); while (recent.length > 6) recent.shift(); try { writeFileSync(PROGRESS, JSON.stringify(recent)); } catch {} };
const describeTool = (name, inp) => {
  inp = inp || {};
  switch (name) {
    case "Read": return "Reading " + base(inp.file_path);
    case "Edit": case "MultiEdit": return "Editing " + base(inp.file_path);
    case "Write": return "Writing " + base(inp.file_path);
    case "Glob": return "Listing files";
    case "Grep": return "Searching the repo";
    case "Bash": { const c = String(inp.command || "").trim().split(/\\s+/).slice(0, 2).join(" "); return c ? ("Running: " + c) : "Running a command"; }
    default: return name || "Working";
  }
};

const input = JSON.parse(readFileSync(${JSON.stringify(`${TOOLS_DIR}/agent-input.json`)}, "utf-8"));
status({ ok: false, stage: "loaded" });
const { query } = await import("@anthropic-ai/claude-agent-sdk");
let resultText = "", sawResult = false;
for await (const m of query({
  prompt: input.prompt,
  options: {
    model: input.model,
    allowedTools: ${JSON.stringify([...CONFIG_AGENT_REPO_TOOLS])},
    permissionMode: "dontAsk",
    cwd: ${JSON.stringify(REPO_DIR)},
    env: { ...process.env, ANTHROPIC_BASE_URL: input.baseUrl, ANTHROPIC_API_KEY: input.apiKey, CLAUDECODE: "" },
    stderr: (d) => errs.push(String(d)),
  },
})) {
  if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
    for (const block of m.message.content) {
      if (block && block.type === "tool_use") emit(describeTool(block.name, block.input));
    }
  }
  if (m.type === "result") {
    if ("result" in m) { sawResult = true; resultText = m.result; }
    else { status({ ok: false, error: "agent-failure:" + m.subtype }); process.exit(0); }
  }
}
status({ ok: sawResult, resultText });
`;
}

async function installAgentSdk(sandbox: Sandbox): Promise<void> {
  await sandbox.writeFiles([
    { path: `${TOOLS_DIR}/package.json`, content: Buffer.from(JSON.stringify({ name: "config-agent-tools", private: true, type: "module" }), "utf-8") },
  ]);
  await run(sandbox, "npm", ["install", "--no-save", `@anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION}`], { cwd: TOOLS_DIR });
}

/** A sanitized live-activity callback (recent agent actions joined by newlines). */
export type AgentProgressSink = (activity: string) => Promise<void>;

const PROGRESS_POLL_MS = 1500;

/**
 * Polls the runner's `progress.json` (last few sanitized tool actions) while the
 * detached command runs and forwards changes to `onProgress`. File-based rather
 * than stdout-streamed so it's robust across the sandbox boundary (the same
 * `readFileToBuffer` path used for `status.json`). `redactTokens` is a 2nd layer.
 */
async function pollAgentProgress(
  sandbox: Sandbox,
  command: Pick<Awaited<ReturnType<Sandbox["runCommand"]>>, "wait">,
  onProgress: AgentProgressSink,
): Promise<void> {
  let finished = false;
  const markFinished = () => {
    finished = true;
  };
  const waiter = command.wait().then(markFinished, markFinished);
  let last = "";
  const readOnce = async () => {
    const buf = await sandbox.readFileToBuffer({ path: `${TOOLS_DIR}/progress.json` }).catch(() => null);
    if (!buf) return;
    let lines: unknown;
    try {
      lines = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!Array.isArray(lines)) return;
    const text = redactTokens(lines.map((l) => String(l)).join("\n")).trim();
    if (text && text !== last) {
      last = text;
      await reportConfigAgentProgress(onProgress, text, "config-repo-agent-progress-record");
    }
  };
  while (!finished) {
    await Promise.race([waiter, new Promise((r) => setTimeout(r, PROGRESS_POLL_MS))]);
    await readOnce();
  }
  await readOnce(); // capture the final state
}

async function runAgent(sandbox: Sandbox, prompt: string, onProgress?: AgentProgressSink): Promise<void> {
  const agentInput = {
    prompt,
    model: getEnvVariable("STACK_CONFIG_AGENT_MODEL", DEFAULT_AGENT_MODEL),
    baseUrl: getEnvVariable("STACK_CLAUDE_PROXY_URL", PRODUCTION_AI_PROXY_BASE_URL),
    apiKey: "stack-auth-proxy",
  };
  // Write runner.mjs fresh each run (not baked into the base snapshot) so changes
  // here take effect immediately instead of being frozen into an old base image.
  await sandbox.writeFiles([
    { path: `${TOOLS_DIR}/runner.mjs`, content: Buffer.from(buildRunnerScript(), "utf-8") },
    { path: `${TOOLS_DIR}/agent-input.json`, content: Buffer.from(JSON.stringify(agentInput), "utf-8") },
  ]);
  // Run detached so we can poll the runner's progress file while it works; status
  // is read from status.json afterwards (the exit code isn't authoritative here).
  const command = await sandbox.runCommand({ cmd: "node", args: [`${TOOLS_DIR}/runner.mjs`], detached: true });
  if (onProgress) {
    await pollAgentProgress(sandbox, command, onProgress).catch((error) => captureError("config-repo-agent-progress", error));
  } else {
    await command.wait().catch(() => {});
  }
  const statusBuf = await sandbox.readFileToBuffer({ path: `${TOOLS_DIR}/status.json` }).catch(() => null);
  const status = statusBuf ? JSON.parse(statusBuf.toString()) : null;
  if (!status?.ok) {
    const detail = status?.error != null ? redactTokens(String(status.error)) : status?.error;
    captureError("config-repo-agent", new ConfigRepoAgentError("Sandbox agent did not complete", { cause: { error: detail, stage: status?.stage } }));
    throw new ConfigRepoAgentError("The config agent could not apply the changes inside the sandbox.");
  }
}

// ---------------------------------------------------------------------------
// Sandbox boot
// ---------------------------------------------------------------------------

async function gitHead(sandbox: Sandbox): Promise<string> {
  return (await run(sandbox, "git", ["-C", REPO_DIR, "rev-parse", "HEAD"])).stdout.trim();
}

/**
 * True if a unified diff contains a binary-file change. We can't reconstruct binary
 * edits from a textual diff (git emits a "Binary files … differ" stub, not content),
 * so such a change is rejected at capture time. `--no-renames` keeps it to add/modify/
 * delete, which `parsePatch` maps cleanly when we rebuild the contents on commit.
 */
function diffHasBinaryChange(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || diff.includes("GIT binary patch");
}

/**
 * Boots a config-agent sandbox with the agent SDK available. If a prebuilt base
 * snapshot is configured (`STACK_CONFIG_AGENT_BASE_SNAPSHOT_ID`) the SDK is already
 * baked in and we warm-boot from it; otherwise we cold-boot a node24 sandbox and
 * install the SDK inline (slower — used locally / before the image is built).
 * The returned sandbox has NO repo cloned yet (the caller clones fresh).
 */
async function bootAgentSandbox(creds: SandboxCreds): Promise<Sandbox> {
  const baseSnapshotId = getEnvVariable("STACK_CONFIG_AGENT_BASE_SNAPSHOT_ID", "");
  if (baseSnapshotId) {
    const sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId: baseSnapshotId },
      resources: { vcpus: 4 },
      timeout: SANDBOX_TIMEOUT_MS,
      teamId: creds.teamId,
      projectId: creds.projectId,
      token: creds.token,
    });
    try {
      // Snapshot boots can ship an empty CA bundle; rebuild it before any HTTPS git.
      await ensureTls(sandbox);
      return sandbox;
    } catch (error) {
      await stopSandboxAfterFailedBoot(sandbox);
      throw error;
    }
  }
  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: SANDBOX_TIMEOUT_MS,
    runtime: "node24",
    teamId: creds.teamId,
    projectId: creds.projectId,
    token: creds.token,
  });
  try {
    await installAgentSdk(sandbox);
    return sandbox;
  } catch (error) {
    await stopSandboxAfterFailedBoot(sandbox);
    throw error;
  }
}

async function stopSandboxAfterFailedBoot(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.stop({ signal: AbortSignal.timeout(5000) });
  } catch (error) {
    captureError("config-repo-agent-failed-boot-stop", error);
  }
}

// ---------------------------------------------------------------------------
// Base snapshot build (one-off, via scripts/config-agent/build-image.ts)
// ---------------------------------------------------------------------------

/**
 * Builds the shared, repo-independent base snapshot: a node24 sandbox with the
 * Claude Agent SDK + git bot identity baked in. Reused (read-only) by every config
 * update via `STACK_CONFIG_AGENT_BASE_SNAPSHOT_ID`. This is the closest thing Vercel
 * Sandbox has to a custom image — it contains NO repo and NO token. Run the build
 * script, then set the printed id as the env var.
 */
export async function buildConfigAgentBaseSnapshot(onProgress?: (msg: string) => void): Promise<{ snapshotId: string }> {
  const creds = sandboxCreds();
  const step = (m: string) => onProgress?.(m);
  step("Starting a sandbox…");
  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: SANDBOX_TIMEOUT_MS,
    runtime: "node24",
    teamId: creds.teamId,
    projectId: creds.projectId,
    token: creds.token,
  });
  try {
    step("Configuring git…");
    await run(sandbox, "git", ["config", "--global", "user.email", GIT_BOT_EMAIL]);
    await run(sandbox, "git", ["config", "--global", "user.name", GIT_BOT_NAME]);
    step("Installing the config agent SDK…");
    await installAgentSdk(sandbox);
    step("Creating the snapshot…");
    const snap = await sandbox.snapshot();
    step("Snapshot ready.");
    return { snapshotId: snap.snapshotId };
  } finally {
    // `snapshot()` already stops the sandbox; this is a best-effort safety net.
    await sandbox.stop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Apply update (on save): run the agent, capture the change set, stop the sandbox
// ---------------------------------------------------------------------------

/**
 * The result of `applyConfigUpdate`. On `awaiting_review` the sandbox has ALREADY
 * been stopped and the change is captured as a diff + base commit in `change`, so the
 * caller only needs to persist it; the commit is rebuilt + pushed later via
 * {@link commitConfigUpdate}.
 */
export type ConfigUpdateApplyResult =
  | {
    mode: "awaiting_review",
    /** The agent's unified diff (review render + commit source) and its base commit. */
    change: CapturedChange,
  }
  | { mode: "no-change" };

export async function applyConfigUpdate(options: {
  getGithubToken: GithubTokenProvider,
  ref: GithubRepoRef,
  completeConfig: NormalizedConfig,
  onSandboxId?: (sandboxId: string) => Promise<void>,
  onStage?: (stage: ConfigAgentInFlightStage) => Promise<void>,
  onProgress?: AgentProgressSink,
}): Promise<ConfigUpdateApplyResult> {
  const { getGithubToken, ref, completeConfig, onSandboxId, onStage, onProgress } = options;
  const creds = sandboxCreds();
  const step = async (msg: string) => {
    await reportConfigAgentProgress(onProgress, msg, "config-repo-agent-step-record");
  };
  const githubToken = await getGithubToken(); // fresh token for the clone

  await reportConfigAgentStage(onStage, "initializing_sandbox");
  await step("Initializing the sandbox…");
  const sandbox = await bootAgentSandbox(creds);
  try {
    // Record the id so a concurrent cancel (a separate invocation) can hard-stop the
    // sandbox while the agent is still running.
    await onSandboxId?.(sandbox.sandboxId);

    // Fresh shallow clone of just the target branch. The tokenized URL is used
    // only for the clone; immediately after, we reset `origin` to a tokenless URL
    // so the agent (which has Bash access) cannot read the token from `.git/config`
    // or `git remote -v`. We never push from the sandbox, so the token is not needed again.
    await reportConfigAgentStage(onStage, "cloning_repo");
    await step(`Cloning ${ref.owner}/${ref.repo}@${ref.branch}…`);
    await run(sandbox, "git", ["clone", "--depth", "1", "--single-branch", "--branch", ref.branch, tokenUrl(githubToken, ref), REPO_DIR]);
    await run(sandbox, "git", ["-C", REPO_DIR, "remote", "set-url", "origin", tokenlessUrl(ref)]);

    // Agent writes the COMPLETE config to the file — no dependency install, no
    // typecheck (the linked repo's CI validates the committed change).
    await reportConfigAgentStage(onStage, "agent_making_changes");
    await step("Agent editing config…");
    await runAgent(sandbox, buildCompleteConfigAgentPrompt({
      scope: { mode: "repo" },
      completeConfig,
      commandPolicy: "Do NOT install dependencies, run builds, or run a type check. The repository's own CI validates the change after we push, and dependencies are intentionally not installed in this sandbox.",
    }), onProgress);

    // Stage everything so new/renamed files are captured too, then check for changes.
    await run(sandbox, "git", ["-C", REPO_DIR, "add", "-A"]);
    const dirty = (await runRaw(sandbox, "git", ["-C", REPO_DIR, "status", "--porcelain"])).stdout.trim();
    if (dirty === "") {
      return { mode: "no-change" };
    }

    // `add -A` does not move HEAD, so this is still the commit we cloned — the base
    // the diff is rebuilt against, and our fast-forward conflict check, at commit time.
    const baseSha = await gitHead(sandbox);
    // The diff drives BOTH the review render and the commit (`--no-renames` keeps it to
    // add/modify/delete; `--cached HEAD` includes newly created files). Captured VERBATIM:
    // it is the authoritative commit source, so it must never be altered. The GitHub token
    // can't appear here anyway — it lives only in `.git/config` (which `git diff` never
    // reads) and is reset to a tokenless URL before the agent runs, so tracked content
    // never contains it. (Token scrubbing stays on the error/log paths, where the tokenized
    // clone URL genuinely can surface.)
    const diff = (await runRaw(sandbox, "git", ["-c", "core.quotePath=false", "-C", REPO_DIR, "diff", "--cached", "--no-renames", "HEAD"])).stdout;
    if (diff.trim() === "") {
      return { mode: "no-change" };
    }
    if (diffHasBinaryChange(diff)) {
      throw new ConfigRepoAgentError("The config change includes a binary file, which can't be committed from the dashboard.");
    }
    if (Buffer.byteLength(diff, "utf-8") > MAX_CONFIG_DIFF_BYTES) {
      throw new ConfigRepoAgentError("The config change is too large to commit.");
    }
    return { mode: "awaiting_review", change: { diff, baseSha } };
  } finally {
    // The sandbox's whole job is done once the change set is captured; the commit is
    // replayed later via the GitHub API, so we never keep it alive for review.
    await stopSandboxWithContext(sandbox.sandboxId, "config-repo-agent-apply-stop");
  }
}

// ---------------------------------------------------------------------------
// Commit (on confirm): rebuild contents from the diff + base, push via the REST API
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
// Git tree mode for the files we write. The config agent only edits regular text
// files; mode changes aren't carried by the textual diff, so everything is 100644.
const TREE_FILE_MODE = "100644";

type GithubFetchResult = { ok: boolean, status: number, json: Json | null };

function jsonObjectField(value: Json | null, key: string): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;
}

function jsonStringField(value: Json | null, key: string): string | undefined {
  const field = jsonObjectField(value, key);
  return typeof field === "string" ? field : undefined;
}

/** One reconstructed file ready for the commit tree. Deletions carry no content. */
export type CommitFile = { path: string, newContent: string } | { path: string, deleted: true };

/** Branch ref path segment, encoding each component but keeping `/` literal (refs can be nested). */
function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** Encode a repo file path for a URL, keeping `/` literal between segments. */
function encodeFilePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Authenticated api.github.com request. The token is sent only as a header, never in a URL. */
async function githubFetch(token: string, method: string, path: string, body?: Json): Promise<GithubFetchResult> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hexclave-config-agent",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: Json | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/** Like {@link githubFetch} but throws on a non-2xx response. Error messages never include the token. */
async function githubJson(token: string, method: string, path: string, body?: Json): Promise<Json | null> {
  const r = await githubFetch(token, method, path, body);
  if (!r.ok) {
    const detail = jsonStringField(r.json, "message") === undefined ? "" : `: ${jsonStringField(r.json, "message")}`;
    throw new ConfigRepoAgentError(`GitHub API ${method} ${path} failed (${r.status})${detail}`);
  }
  return r.json;
}

/** Strip git's `a/` / `b/` diff prefix from a filename (and treat `/dev/null` as absent). */
function stripDiffPrefix(name: string | undefined): string | null {
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "");
}

/**
 * Fetches a file's content at a specific commit from GitHub, as a UTF-8 string. Returns
 * "" if the file does not exist at that commit (a freshly added file). Falls back to the
 * blob API when the contents API declines to inline a large file.
 */
async function fetchBaseFileContent(token: string, repoPath: string, filePath: string, baseSha: string): Promise<string> {
  const r = await githubFetch(token, "GET", `${repoPath}/contents/${encodeFilePath(filePath)}?ref=${baseSha}`);
  if (r.status === 404) return "";
  if (!r.ok) {
    const detail = jsonStringField(r.json, "message") === undefined ? "" : `: ${jsonStringField(r.json, "message")}`;
    throw new ConfigRepoAgentError(`GitHub API GET ${repoPath}/contents failed (${r.status})${detail}`);
  }
  const encoding = jsonStringField(r.json, "encoding");
  const content = jsonStringField(r.json, "content");
  if (encoding === "base64" && content !== undefined) {
    return Buffer.from(content, "base64").toString("utf-8");
  }
  // Large files: the contents API returns no inline content; fetch the blob by sha.
  const sha = jsonStringField(r.json, "sha");
  if (sha !== undefined) {
    const blob = await githubJson(token, "GET", `${repoPath}/git/blobs/${sha}`);
    const blobEncoding = jsonStringField(blob, "encoding");
    const blobContent = jsonStringField(blob, "content");
    if (blobEncoding === "base64" && blobContent !== undefined) {
      return Buffer.from(blobContent, "base64").toString("utf-8");
    }
  }
  throw new ConfigRepoAgentError(`Could not read the base content of ${filePath} from GitHub.`);
}

/**
 * Rebuilds the changed files by applying a unified diff onto the base content of each
 * file, which `getBaseContent` resolves by path (new files apply onto ""). Pure aside
 * from that resolver, so it is unit-testable. Because the base matches the diff's
 * context lines exactly, `applyPatch` is deterministic. Deletions are recorded as such.
 * Throws (→ a retryable commit error) if a hunk fails to apply.
 */
export async function rebuildFilesFromDiff(diff: string, getBaseContent: (path: string) => Promise<string>): Promise<CommitFile[]> {
  const files: CommitFile[] = [];
  for (const patch of parsePatch(diff)) {
    const oldPath = stripDiffPrefix(patch.oldFileName);
    const newPath = stripDiffPrefix(patch.newFileName);
    if (newPath === null) {
      // Deletion (newFileName is /dev/null).
      if (oldPath !== null) files.push({ path: oldPath, deleted: true });
      continue;
    }
    // Added file: oldPath is /dev/null → base is empty. Otherwise resolve the base.
    const base = oldPath === null ? "" : await getBaseContent(oldPath);
    const applied = applyPatch(base, patch);
    if (applied === false) {
      throw new ConfigRepoAgentError(`Could not rebuild ${newPath} from the stored diff.`);
    }
    files.push({ path: newPath, newContent: applied });
  }
  return files;
}

/**
 * Commits a captured change to the linked branch via GitHub's git data API — no
 * sandbox required, so it works no matter how long the review took. The change is
 * stored only as a diff + base commit; here we rebuild the file contents by applying
 * that diff onto the base, then: verify the branch still points at the base (fast-
 * forward guard), create a blob per file, build a tree on the base tree (deletions via
 * `sha: null`), create the commit, and fast-forward the branch ref. A concurrent push
 * surfaces as {@link ConfigRepoCommitConflictError} (the pre-check mismatch or a 422
 * from the non-forced ref update). The token is fetched fresh — the user may have been
 * reviewing for a while.
 */
export async function commitConfigUpdate(options: {
  getGithubToken: GithubTokenProvider,
  ref: GithubRepoRef,
  commitMessage: string,
  change: CapturedChange,
}): Promise<ConfigUpdateCommitResult> {
  const { ref, commitMessage, change } = options;
  const token = await options.getGithubToken();
  const repoPath = `/repos/${ref.owner}/${ref.repo}`;
  const encodedBranch = encodeBranchPath(ref.branch);

  // 1. Fast-forward guard: the branch must still be at the commit we cloned. (The
  //    non-forced ref update in step 6 guards the remaining race window too.)
  const refData = await githubJson(token, "GET", `${repoPath}/git/ref/heads/${encodedBranch}`);
  if (jsonStringField(jsonObjectField(refData, "object"), "sha") !== change.baseSha) {
    throw new ConfigRepoCommitConflictError();
  }

  // 2. Rebuild every file the agent changed from the diff applied onto the exact base
  //    files. The diff spans the whole repo (config file + any imports/codegen it pulls
  //    in), so this reproduces the agent's full change, not just the config file.
  const files = await rebuildFilesFromDiff(change.diff, (path) => fetchBaseFileContent(token, repoPath, path, change.baseSha));
  if (files.length === 0) {
    throw new ConfigRepoAgentError("The stored diff produced no file changes to commit.");
  }

  // 3. Resolve the base tree so we only have to specify changed entries.
  const baseCommit = await githubJson(token, "GET", `${repoPath}/git/commits/${change.baseSha}`);
  const baseTreeSha = jsonStringField(jsonObjectField(baseCommit, "tree"), "sha");
  if (typeof baseTreeSha !== "string") {
    throw new ConfigRepoAgentError("Could not resolve the base tree for the config commit.");
  }

  // 4. Create a blob per non-deleted file and build the tree entries.
  const treeEntries: Array<{ path: string, mode: string, type: "blob", sha: string | null }> = [];
  for (const file of files) {
    if ("deleted" in file) {
      treeEntries.push({ path: file.path, mode: TREE_FILE_MODE, type: "blob", sha: null });
      continue;
    }
    const blob = await githubJson(token, "POST", `${repoPath}/git/blobs`, {
      content: Buffer.from(file.newContent, "utf-8").toString("base64"),
      encoding: "base64",
    });
    const blobSha = jsonStringField(blob, "sha");
    if (blobSha === undefined) {
      throw new ConfigRepoAgentError("GitHub did not return a blob sha for a config file.");
    }
    treeEntries.push({ path: file.path, mode: TREE_FILE_MODE, type: "blob", sha: blobSha });
  }

  // 5. Build the new tree on top of the base.
  const tree = await githubJson(token, "POST", `${repoPath}/git/trees`, { base_tree: baseTreeSha, tree: treeEntries });
  const treeSha = jsonStringField(tree, "sha");
  if (treeSha === undefined) {
    throw new ConfigRepoAgentError("GitHub did not return a tree sha for the config commit.");
  }

  // 6. Create the commit object with the bot identity as author and committer.
  const identity = { name: GIT_BOT_NAME, email: GIT_BOT_EMAIL };
  const commitObj = await githubJson(token, "POST", `${repoPath}/git/commits`, {
    message: commitMessage,
    tree: treeSha,
    parents: [change.baseSha],
    author: identity,
    committer: identity,
  });
  const commitSha = jsonStringField(commitObj, "sha");
  if (commitSha === undefined) {
    throw new ConfigRepoAgentError("GitHub did not return a commit sha.");
  }

  // 7. Fast-forward the branch. force:false → GitHub rejects a non-fast-forward
  //    (someone pushed since our pre-check) with 422, which is a commit conflict.
  const update = await githubFetch(token, "PATCH", `${repoPath}/git/refs/heads/${encodedBranch}`, { sha: commitSha, force: false });
  if (!update.ok) {
    if (update.status === 422) {
      throw new ConfigRepoCommitConflictError();
    }
    const detail = jsonStringField(update.json, "message") === undefined ? "" : `: ${jsonStringField(update.json, "message")}`;
    throw new ConfigRepoAgentError(`Failed to update the branch ref (${update.status})${detail}`);
  }

  return {
    mode: "commit-to-branch",
    branch: ref.branch,
    commitUrl: `https://github.com/${ref.owner}/${ref.repo}/commit/${commitSha}`,
    commitSha,
  };
}

// ---------------------------------------------------------------------------
// Cancel (hard-stop an in-flight run's sandbox)
// ---------------------------------------------------------------------------

/**
 * Hard-stops an in-flight run's sandbox by id (called from the cancel route, a
 * different invocation than the one running the agent). Best-effort: a sandbox
 * that already finished/stopped just no-ops. Only `running` runs have a live
 * sandbox now — once captured (`awaiting_review`) the sandbox is already gone, so
 * cancelling then just flips the row to terminal with nothing to stop.
 */
export async function stopConfigAgentSandbox(sandboxId: string): Promise<void> {
  await stopSandboxWithContext(sandboxId, "config-repo-agent-cancel-stop");
}
