import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import { DEFAULT_FREESTYLE_SNAPSHOT_ID } from "../src/lib/freestyle-vm-constants";

const NODE_VERSION = "24.22.1";
// The unofficial-builds glibc-217 build has static libstdc++/libgcc and works on
// BusyBox's glibc-only userland. Use .tar.gz because xz needs a 64 MiB dictionary.
const NODE_ARCHIVE_URL = `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-glibc-217.tar.gz`;
const NODE_ARCHIVE_SHA256 = "422ddeec2c08902a34ef80ae25de388c7b7e2920763030a5262d56b10675c570";
const snapshotId = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_SNAPSHOT_ID",
  "STACK_FREESTYLE_SNAPSHOT_ID",
)
  ?? DEFAULT_FREESTYLE_SNAPSHOT_ID;
const baseUrl = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_API_ENDPOINT",
  "STACK_FREESTYLE_API_ENDPOINT",
);
const apiKey = readHexclaveEnvironmentVariable(
  "HEXCLAVE_FREESTYLE_API_KEY",
  "STACK_FREESTYLE_API_KEY",
) ?? readEnvironmentVariable("FREESTYLE_API_KEY");

function readEnvironmentVariable(name: string): string | undefined {
  // This bootstrap must run before Hexclave or its generated shared package is
  // built, so it deliberately cannot depend on the backend getEnvVariable helper.
  // eslint-disable-next-line no-restricted-syntax
  const value = process.env[name];
  return value === "" ? undefined : value;
}

function readHexclaveEnvironmentVariable(
  hexclaveName: string,
  stackName: string,
): string | undefined {
  const hexclaveValue = readEnvironmentVariable(hexclaveName);
  const stackValue = readEnvironmentVariable(stackName);
  if (hexclaveValue != null && stackValue != null && hexclaveValue !== stackValue) {
    throw new Error(`${hexclaveName} and ${stackName} are both set to different values`);
  }
  return hexclaveValue ?? stackValue;
}

if (apiKey == null) {
  throw new Error("Set HEXCLAVE_FREESTYLE_API_KEY, STACK_FREESTYLE_API_KEY, or FREESTYLE_API_KEY before bootstrapping the snapshot.");
}

// A full run takes several minutes (a ~64 MB download, the same upload into the
// VM, then two in-VM steps with 5-minute timeouts) and was otherwise silent until
// the end, which is indistinguishable from a hang. Log each step with elapsed time.
const startedAt = performance.now();
function logStep(message: string) {
  process.stdout.write(`[${((performance.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

const freestyle = new Freestyle({ apiKey, baseUrl });
logStep(`Checking that snapshot slug ${snapshotId} is unused...`);
try {
  const existing = await freestyle.vms.snapshots.get(snapshotId);
  throw new Error(`Snapshot slug ${snapshotId} already belongs to ${existing.id}; choose a new HEXCLAVE_FREESTYLE_SNAPSHOT_ID or delete the old snapshot explicitly.`);
} catch (error) {
  if (!(error instanceof FreestyleApiError) || error.status !== 404) throw error;
}

logStep(`Downloading ${NODE_ARCHIVE_URL}...`);
const archiveResponse = await fetch(NODE_ARCHIVE_URL);
if (!archiveResponse.ok) {
  throw new Error(`Failed to download Node ${NODE_VERSION} (HTTP ${archiveResponse.status})`);
}
const archive = new Uint8Array(await archiveResponse.arrayBuffer());
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
if (archiveSha256 !== NODE_ARCHIVE_SHA256) {
  throw new Error(`Node archive checksum mismatch: expected ${NODE_ARCHIVE_SHA256}, received ${archiveSha256}`);
}

const bootstrapScript = await readFile(
  new URL("./freestyle-snapshot-bootstrap.sh", import.meta.url),
  "utf8",
);

logStep(`Downloaded and verified Node archive (${archive.byteLength} bytes). Creating builder VM...`);
const { vm } = await freestyle.vms.create({
  snapshotId: "freestyle/busybox",
  ttlSeconds: 30 * 60,
  automaticRestart: false,
  metadata: {
    app: "hexclave",
    purpose: "javascript-snapshot-builder",
  },
  firewall: {
    rules: [{ action: "allow", source: {}, destination: { public: true } }],
  },
});

logStep(`Created builder VM ${vm.id}. Resizing...`);
try {
  await vm.resize({ memory: 1024, storage: 2048 });
  logStep("Uploading Node archive and bootstrap script into the VM...");
  await Promise.all([
    vm.fs.writeFile("/opt/hexclave-node-archive.tar.gz", archive),
    vm.fs.writeTextFile("/opt/hexclave-node-archive.sha256", `${NODE_ARCHIVE_SHA256}\n`),
    vm.fs.writeTextFile(
      "/tmp/freestyle-snapshot-bootstrap.sh",
      bootstrapScript,
      { mode: 0o700 },
    ),
  ]);
  logStep("Running bootstrap script in the VM (up to 5 minutes)...");
  const bootstrap = await vm.exec({
    command: `NODE_VERSION=${NODE_VERSION} /tmp/freestyle-snapshot-bootstrap.sh`,
    timeoutMs: 300_000,
  });
  if (bootstrap.statusCode !== 0) {
    throw new Error(`Snapshot bootstrap exited with status ${bootstrap.statusCode}: ${bootstrap.stderr ?? ""}`);
  }

  logStep("Bootstrap done. Verifying that npm can install a package (up to 5 minutes)...");
  const verificationId = "00000000-0000-4000-8000-000000000000";
  const verificationHostDirectory = `/opt/hexclave-runtime/work/${verificationId}`;
  await vm.fs.mkdir(verificationHostDirectory);
  await Promise.all([
    vm.fs.writeTextFile(
      `${verificationHostDirectory}/package.json`,
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "is-odd": "3.0.1" },
      }) + "\n",
    ),
    vm.fs.writeTextFile(
      `${verificationHostDirectory}/runner.mjs`,
      `import isOdd from "is-odd";\nimport { writeFile } from "node:fs/promises";\nif (!isOdd(3)) throw new Error("is-odd verification failed");\nawait writeFile("./verified", process.version);\n`,
    ),
  ]);
  const verification = await vm.exec({
    command: `/usr/local/bin/hexclave-run-job ${verificationHostDirectory}`,
    timeoutMs: 300_000,
  });
  if (verification.statusCode !== 0) {
    throw new Error(`Snapshot verification exited with status ${verification.statusCode}: ${verification.stderr ?? ""}`);
  }
  const verifiedNodeVersion = await vm.fs.readTextFile(`${verificationHostDirectory}/verified`);
  if (!verifiedNodeVersion.startsWith("v24.")) {
    throw new Error(`Snapshot verification expected Node 24, received ${verifiedNodeVersion}`);
  }

  logStep(`Verified ${verifiedNodeVersion}. Taking snapshot...`);
  const { snapshot, snapshotId: createdSnapshotId } = await vm.snapshot({
    slug: snapshotId,
    displayName: "Hexclave BusyBox JavaScript sandbox (Node 24)",
  });
  logStep(`Created Freestyle snapshot ${snapshot.slug ?? createdSnapshotId} (${createdSnapshotId})`);
} finally {
  logStep(`Deleting builder VM ${vm.id}...`);
  await vm.delete();
}
