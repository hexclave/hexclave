import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Freestyle, FreestyleApiError } from "freestyle";
import {
  DEFAULT_REPLAY_RENDER_SNAPSHOT_ID,
  REPLAY_RENDER_JOBS_DIR,
  REPLAY_RENDER_LINUX_USER,
  REPLAY_RENDER_RUNTIME_DIR,
} from "./constants";
import { parseProgress, parseResult, type ReplayRenderRuntime } from "./types";

/** A render VM is deleted by Freestyle itself this long after creation, whatever happens to us. */
export const FREESTYLE_RENDER_VM_TTL_SECONDS = 30 * 60;
const SECTION_SEPARATOR = "\n--hexclave-section--\n";
const EXIT_FILE = "/tmp/render.exit";
const LOG_FILE = "/tmp/render.log";

/**
 * Production runtime: one single-use Freestyle VM per render, booted from the
 * replay-render snapshot (scripts/bootstrap-replay-render-snapshot.ts).
 *
 * The VM receives only params.json — presigned URLs scoped to this render's
 * chunks and output object — and has no credentials of any kind. It may reach
 * the public internet (page assets referenced by the recording, and the bucket),
 * but not private addresses.
 */
export function createFreestyleReplayRenderRuntime(apiKey: string): ReplayRenderRuntime {
  const freestyle = new Freestyle({
    apiKey,
    baseUrl: getEnvVariable("STACK_FREESTYLE_API_ENDPOINT", "") || undefined,
  });
  const snapshotId = getEnvVariable("STACK_FREESTYLE_REPLAY_RENDER_SNAPSHOT_ID", "") || DEFAULT_REPLAY_RENDER_SNAPSHOT_ID;

  // vm.fs and exec() act as the image's `ubuntu` user unless told otherwise.
  async function rootExec(vmId: string, command: string) {
    const result = await freestyle.vms.ref(vmId).exec({ command, linuxUser: "root", timeoutMs: 30_000 });
    if (result.statusCode !== 0) {
      throw new HexclaveAssertionError("Command in replay render VM failed", { vmId, statusCode: result.statusCode, stderr: result.stderr });
    }
    return result.stdout ?? "";
  }

  return {
    name: "freestyle",
    async start(params) {
      const { vm, vmId } = await freestyle.vms.create({
        snapshotId,
        automaticRestart: false,
        // Deleted the moment it stops; the TTL is a provider-side backstop for
        // renders this backend loses track of.
        autoDeleteSeconds: 0,
        maxRunSeconds: FREESTYLE_RENDER_VM_TTL_SECONDS,
        ttlSeconds: FREESTYLE_RENDER_VM_TTL_SECONDS,
        metadata: { app: "hexclave", purpose: "session-replay-render" },
        firewall: {
          rules: [{ action: "allow", source: {}, destination: { public: true } }],
        },
      });
      try {
        const jobId = crypto.randomUUID();
        const jobDir = `${REPLAY_RENDER_JOBS_DIR}/${jobId}`;
        const stagingDir = `/tmp/stage-${jobId}`;
        await vm.fs.mkdir(stagingDir);
        await vm.fs.writeTextFile(`${stagingDir}/params.json`, JSON.stringify(params));
        await rootExec(vmId, [
          `install -d -o ${REPLAY_RENDER_LINUX_USER} -g ${REPLAY_RENDER_LINUX_USER} -m 700 ${jobDir}`,
          `mv ${stagingDir}/params.json ${jobDir}/params.json`,
          `chown ${REPLAY_RENDER_LINUX_USER}:${REPLAY_RENDER_LINUX_USER} ${jobDir}/params.json`,
          `rmdir ${stagingDir}`,
        ].join(" && "));

        // exec() is capped at five minutes and kills anything it started in
        // the background; a PTY session belongs to the guest agent and keeps
        // running after we detach. Its exit code lands in EXIT_FILE.
        const session = await vm.pty.open({
          slug: "render",
          linuxUser: "root",
          exec: `/bin/sh -c 'cd ${REPLAY_RENDER_RUNTIME_DIR} && runuser -u ${REPLAY_RENDER_LINUX_USER} -- env HOME=/home/${REPLAY_RENDER_LINUX_USER} node render.mjs ${jobDir} > ${LOG_FILE} 2>&1; echo $? > ${EXIT_FILE}'`,
        });
        session.detach();
        return { vmId, jobDir };
      } catch (error) {
        await vm.delete().catch(() => {});
        throw error;
      }
    },

    async poll(handle) {
      const { vmId, jobDir } = handle;
      const status = await rootExec(vmId, `cat ${EXIT_FILE} 2>/dev/null; printf '${SECTION_SEPARATOR}'; cat ${jobDir}/progress.json 2>/dev/null; true`);
      const [exitText, progressText] = status.split(SECTION_SEPARATOR);
      if (exitText.trim() === "") {
        return { state: "running", progress: parseProgress(tryParseJson(progressText)) };
      }
      const output = await rootExec(vmId, `cat ${jobDir}/result.json 2>/dev/null; printf '${SECTION_SEPARATOR}'; tail -c 4000 ${LOG_FILE} 2>/dev/null; true`);
      const [resultText, log] = output.split(SECTION_SEPARATOR);
      return {
        state: "exited",
        exitCode: Number(exitText.trim()),
        result: parseResult(tryParseJson(resultText)),
        log: log,
      };
    },

    async dispose(handle) {
      try {
        await freestyle.vms.ref(handle.vmId).delete();
      } catch (error) {
        if (error instanceof FreestyleApiError && error.status === 404) return;
        throw error;
      }
    },
  };
}

function tryParseJson(text: string | undefined): unknown {
  if (!text?.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
