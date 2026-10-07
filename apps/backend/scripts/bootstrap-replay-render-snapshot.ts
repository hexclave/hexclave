import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import { DEFAULT_REPLAY_RENDER_SNAPSHOT_ID } from "../src/lib/session-replay-renders/constants";

// Builds the Freestyle snapshot that session replay renders boot from: Ubuntu +
// Node + chrome-headless-shell + ffmpeg + scripts/replay-render/render.mjs.
// Bump DEFAULT_REPLAY_RENDER_SNAPSHOT_ID and re-run whenever render.mjs,
// session-replay-timeline.ts or snapshot-bootstrap.sh changes; snapshots are immutable.
const NODE_ARCHIVE_SHA256 = "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc";
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;

const snapshotId = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_REPLAY_RENDER_SNAPSHOT_ID",
  "STACK_FREESTYLE_REPLAY_RENDER_SNAPSHOT_ID",
) ?? DEFAULT_REPLAY_RENDER_SNAPSHOT_ID;
const baseUrl = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_API_ENDPOINT",
  "STACK_FREESTYLE_API_ENDPOINT",
);
const apiKey = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_API_KEY",
  "STACK_FREESTYLE_API_KEY",
) ?? readEnvironmentVariable("FREESTYLE_API_KEY");

function readEnvironmentVariable(name: string): string | undefined {
  // Runs before the shared package is built, so it cannot use getEnvVariable.
  // eslint-disable-next-line no-restricted-syntax
  const value = process.env[name];
  return value === "" ? undefined : value;
}

function readHexclaveEnvironmentVariable(hexclaveName: string, stackName: string): string | undefined {
  const hexclaveValue = readEnvironmentVariable(hexclaveName);
  const stackValue = readEnvironmentVariable(stackName);
  if (hexclaveValue != null && stackValue != null && hexclaveValue !== stackValue) {
    throw new Error(`${hexclaveName} and ${stackName} are both set to different values`);
  }
  return hexclaveValue ?? stackValue;
}

if (apiKey == null || apiKey.startsWith("mock_")) {
  throw new Error("Set HEXCLAVE_FREESTYLE_API_KEY (or STACK_FREESTYLE_API_KEY / FREESTYLE_API_KEY) to a real Freestyle key before bootstrapping the snapshot.");
}

const freestyle = new Freestyle({ apiKey, baseUrl });
try {
  const existing = await freestyle.vms.snapshots.get(snapshotId);
  throw new Error(`Snapshot slug ${snapshotId} already belongs to ${existing.id}; choose a new HEXCLAVE_FREESTYLE_REPLAY_RENDER_SNAPSHOT_ID or delete the old snapshot explicitly.`);
} catch (error) {
  if (!(error instanceof FreestyleApiError) || error.status !== 404) throw error;
}

const [renderScript, timelineModule, bootstrapScript] = await Promise.all([
  readFile(new URL("./replay-render/render.mjs", import.meta.url), "utf8"),
  // render.mjs imports this as ./session-replay-timeline.ts so videos follow the
  // active tab with exactly the dashboard player's rule.
  readFile(new URL("../../../packages/shared/src/utils/session-replay-timeline.ts", import.meta.url), "utf8"),
  readFile(new URL("./replay-render/snapshot-bootstrap.sh", import.meta.url), "utf8"),
]);

const { vm, vmId } = await freestyle.vms.create({
  snapshotId: "freestyle/ubuntu-sm",
  ttlSeconds: 45 * 60,
  automaticRestart: false,
  metadata: {
    app: "hexclave",
    purpose: "replay-render-snapshot-builder",
  },
  firewall: {
    rules: [{ action: "allow", source: {}, destination: { public: true } }],
  },
});
process.stdout.write(`Builder VM ${vmId} created\n`);

try {
  await Promise.all([
    vm.fs.writeTextFile("/tmp/render.mjs", renderScript),
    vm.fs.writeTextFile("/tmp/session-replay-timeline.ts", timelineModule),
    vm.fs.writeTextFile("/tmp/snapshot-bootstrap.sh", bootstrapScript),
  ]);

  // exec() is capped at five minutes and reaps anything it started in the
  // background; PTY sessions belong to the guest agent and survive a detach.
  // They default to the image's `ubuntu` user, hence linuxUser: "root".
  const runId = randomUUID();
  const session = await vm.pty.open({
    slug: `bootstrap-${runId.slice(0, 8)}`,
    linuxUser: "root",
    exec: `/bin/sh -c 'NODE_ARCHIVE_SHA256=${NODE_ARCHIVE_SHA256} sh /tmp/snapshot-bootstrap.sh > /tmp/bootstrap.log 2>&1; echo $? > /tmp/bootstrap.exit'`,
  });
  session.detach();

  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  let exitCode: number | null = null;
  while (exitCode == null) {
    if (Date.now() > deadline) throw new Error("Snapshot bootstrap timed out");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const probe = await vm.exec({ command: "cat /tmp/bootstrap.exit 2>/dev/null; echo '|'; tail -n 1 /tmp/bootstrap.log 2>/dev/null", linuxUser: "root", timeoutMs: 30_000 });
    const [exit, tail] = (probe.stdout ?? "").split("|").map((part) => part.trim());
    if (exit) {
      exitCode = Number(exit);
    } else {
      process.stdout.write(`… ${tail.slice(0, 160)}\n`);
    }
  }
  const log = await vm.exec({ command: "tail -n 30 /tmp/bootstrap.log", linuxUser: "root", timeoutMs: 30_000 });
  process.stdout.write(`${log.stdout ?? ""}\n`);
  if (exitCode !== 0) {
    throw new Error(`Snapshot bootstrap exited with status ${exitCode}`);
  }

  const { snapshot, snapshotId: createdSnapshotId } = await vm.snapshot({
    slug: snapshotId,
    displayName: "Hexclave session replay renderer",
  });
  process.stdout.write(`Created Freestyle snapshot ${snapshot.slug ?? createdSnapshotId} (${createdSnapshotId})\n`);
} finally {
  await vm.delete();
}
