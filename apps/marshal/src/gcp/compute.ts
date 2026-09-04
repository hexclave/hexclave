import { setTimeout as delay } from "node:timers/promises";
import { GcpApiError, GcpClient } from "./client.js";

export type ComputeConfig = {
  projectId: string,
  region: string,
  zone: string,
  network: string,
  subnetwork: string,
};

export type ComputeDisk = {
  name: string,
  sizeGb: number,
  status: string,
};

export type ComputeInstance = {
  id: string,
  name: string,
  status: string,
  revision: string | null,
  internalIp: string | null,
  imageRef: string | null,
};

export type ComputeInstanceSpec = {
  name: string,
  image: string,
  env: Record<string, string>,
  ports: number[],
  revision: string,
  startCommand: string | null,
  volume: { diskName: string, path: string } | null,
  serviceKeyHash: string,
};

export type BuilderVmSpec = {
  name: string,
  image: string,
  machineType: string,
  diskSizeGb: number,
  files: { path: string, contentsBase64: string }[],
  env: Record<string, string>,
};

type ComputeOperation = {
  selfLink: string,
  status: string,
  errorMessage: string | null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOperation(value: unknown): ComputeOperation {
  if (!isRecord(value) || typeof value.selfLink !== "string" || typeof value.status !== "string") {
    throw new Error("Compute Engine returned an invalid operation");
  }
  let errorMessage: string | null = null;
  if (isRecord(value.error) && Array.isArray(value.error.errors)) {
    const messages = value.error.errors.flatMap((entry) => isRecord(entry) && typeof entry.message === "string" ? [entry.message] : []);
    if (messages.length > 0) errorMessage = messages.join("; ");
  }
  return { selfLink: value.selfLink, status: value.status, errorMessage };
}

function metadataValue(instance: Record<string, unknown>, key: string): string | null {
  if (!isRecord(instance.metadata) || !Array.isArray(instance.metadata.items)) return null;
  for (const item of instance.metadata.items) {
    if (isRecord(item) && item.key === key && typeof item.value === "string") return item.value;
  }
  return null;
}

function parseInstance(value: unknown): ComputeInstance {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.status !== "string") {
    throw new Error("Compute Engine returned an invalid instance");
  }
  let internalIp: string | null = null;
  if (Array.isArray(value.networkInterfaces)) {
    const first = value.networkInterfaces[0];
    if (isRecord(first) && typeof first.networkIP === "string") internalIp = first.networkIP;
  }
  return { id: value.id, name: value.name, status: value.status, revision: metadataValue(value, "hexclave-revision"), internalIp, imageRef: null };
}

// Deliberately NOT anchored to line boundaries. The serial console prefixes every line the
// startup script prints ("[   32.66] google_metadata_script_runner_adapt[791]: startup-script:
// MARSHAL_IMAGE_REF ..."), and kernel messages can splice themselves into the middle of a
// line, so `^...$` never matched real output — the VM came up and reconciliation then failed
// claiming it had reported no image. Requiring the digest shape instead of `\S+` keeps a
// spliced line from yielding a truncated ref.
function imageRefFromSerialOutput(output: string): string | null {
  const matches = [...output.matchAll(/MARSHAL_IMAGE_REF (\S+@sha256:[0-9a-f]{64})/g)];
  return matches.at(-1)?.[1] ?? null;
}

// Each of these is echoed by the startup script immediately before it exits non-zero, and
// each names a DIFFERENT stage. Reporting them matters because the tail of the serial console
// never does: the last lines are always the metadata runner's generic "Script failed with
// error: exit status 1", "Finished running startup scripts", and konlet's "No metadata
// present", so a plain tail truncates away the one line that explains the failure and every
// distinct cause reaches the operator looking identical.
const SERVICE_FAILURE_MARKERS: { marker: string, reason: string }[] = [
  { marker: "MARSHAL_SERVICE_START_FAILED", reason: "the image could not be pulled or the container could not be created, after 12 attempts" },
  { marker: "MARSHAL_SERVICE_NOT_READY", reason: "the container did not stay running with every declared port accepting connections; a service that listens on a different port than it declares fails here" },
  { marker: "MARSHAL_SERVICE_IMAGE_UNRESOLVED", reason: "the container started but Docker reported no repository digest for its image" },
];

// The serial console is cumulative over the instance's whole life, so an earlier revision's
// failure marker can still be present. Take the LAST marker written, which is the one
// belonging to the run that just failed.
function serviceFailureReason(output: string): string | null {
  let latest: { at: number, reason: string, marker: string } | null = null;
  for (const { marker, reason } of SERVICE_FAILURE_MARKERS) {
    const at = output.lastIndexOf(marker);
    if (at !== -1 && (latest === null || at > latest.at)) latest = { at, reason, marker };
  }
  return latest === null ? null : `${latest.reason} (${latest.marker})`;
}

function parseDisk(value: unknown): ComputeDisk {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.status !== "string") throw new Error("Compute Engine returned an invalid disk");
  const rawSize = value.sizeGb;
  const sizeGb = typeof rawSize === "string" ? Number(rawSize) : rawSize;
  if (typeof sizeGb !== "number" || !Number.isInteger(sizeGb)) throw new Error(`Compute Engine returned an invalid size for disk ${value.name}`);
  return { name: value.name, sizeGb, status: value.status };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Container-Optimized OS mounts its root filesystem READ-ONLY, so the persistent disk has to
// land under /mnt/disks — the writable mount point COS provides for exactly this. Anything
// else (/mnt/hexclave-data, say) fails `mkdir` with "Read-only file system", and because the
// startup script runs under `set -e` that aborts it before Docker ever starts: the VM reaches
// RUNNING, never prints MARSHAL_SERVICE_READY, and the readiness waiter times out five
// minutes later with nothing to explain why. Verified on real COS.
const DATA_MOUNT = "/mnt/disks/hexclave-data";

export function serviceStartupScript(spec: ComputeInstanceSpec): string {
  const registryHost = spec.image.split("/")[0];
  // docker-credential-gcr writes the credential helper into the Docker config, which defaults
  // to $HOME/.docker — i.e. /root/.docker for this script. Container-Optimized OS mounts / as
  // READ-ONLY, so that mkdir fails with "read-only file system" and set -e kills the startup
  // script before a single container runs. Point both HOME and DOCKER_CONFIG at the stateful
  // partition (/var/lib is writable on COS, which the builder script already depends on), and
  // export them so the later docker pull/run in this same script read the same credentials.
  //
  // Only a Google registry reaches this branch, which is why the live test never caught it:
  // that test deploys public docker.io images, leaving this setup empty. A real source build
  // pushes to Artifact Registry and hits it on the first deploy.
  const registryCredentialSetup = registryHost.endsWith(".pkg.dev") || registryHost.endsWith(".gcr.io") || registryHost === "gcr.io"
    ? `export HOME=/var/lib/marshal-home
export DOCKER_CONFIG=/var/lib/marshal-home/.docker
mkdir -p "$DOCKER_CONFIG"
docker-credential-gcr configure-docker --registries=${shellQuote(registryHost)} >/dev/null`
    : "";
  const dockerArgs = [
    "run", "--detach", "--restart=always", "--name", "marshal-service",
    "--log-driver=gcplogs", "--log-opt", "gcp-log-cmd=true", "--log-opt", "labels=hexclave-service",
    ...Object.entries(spec.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...spec.ports.flatMap((port) => ["--publish", `${port}:${port}`]),
    ...(spec.volume === null ? [] : ["--mount", `type=bind,src=${DATA_MOUNT},dst=${spec.volume.path}`]),
    ...(spec.startCommand === null ? [] : ["--entrypoint", "/bin/sh"]),
    spec.image,
    ...(spec.startCommand === null ? [] : ["-c", spec.startCommand]),
  ];
  const portChecks = spec.ports.map((port) => `probe_port ${port} || return 1`).join("\n  ");
  return `#!/bin/bash
set -euo pipefail
readonly REVISION=${shellQuote(spec.revision)}
readonly IMAGE=${shellQuote(spec.image)}
${spec.volume === null ? "" : `readonly DATA_DEVICE=/dev/disk/by-id/google-${spec.volume.diskName}
until [[ -e "$DATA_DEVICE" ]]; do sleep 1; done
if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then mkfs.ext4 -F "$DATA_DEVICE"; fi
mkdir -p ${DATA_MOUNT}
mountpoint -q ${DATA_MOUNT} || mount "$DATA_DEVICE" ${DATA_MOUNT}
resize2fs "$DATA_DEVICE"
`}
${registryCredentialSetup}
# Retry the pull and the run. A brand-new tenant project grants the VM's service account
# artifactregistry.writer and logging.logWriter moments before this VM boots, and those
# bindings are NOT effective immediately: the first deploy into a fresh project reliably
# lost the race and Docker died with PermissionDenied on the gcplogs driver
# ("logging.logEntries.create denied on .../logs/ping"), which under set -e killed the
# whole script before the container existed. Verified on real GCP.
start_service() {
  docker pull "$IMAGE" || return 1
  docker rm --force marshal-service >/dev/null 2>&1 || true
  docker ${dockerArgs.map(shellQuote).join(" ")} || return 1
}
for attempt in $(seq 1 12); do
  if start_service; then break; fi
  if [[ "$attempt" -eq 12 ]]; then echo 'MARSHAL_SERVICE_START_FAILED'; exit 1; fi
  echo "MARSHAL_SERVICE_START_RETRY $attempt"
  sleep 10
done
# Probe a TCP port WITHOUT bash's /dev/tcp: Container-Optimized OS ships a bash built without
# --enable-net-redirections, so a /dev/tcp network redirection is not a socket there — bash
# treats it as a literal path and prints "No such file or directory". That check could
# therefore never pass on COS, and it failed every "server" deploy regardless of what the
# container was actually serving. curl is present on COS (the builder script already relies on
# it) and reports connection refusal as exit 7, so anything OTHER than 7 means the TCP
# handshake completed — which is what "listening" means for a non-HTTP daemon such as
# PostgreSQL too, even though it answers the HTTP request with a protocol error.
probe_port() {
  local rc=0
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1" || rc=$?
  [[ "$rc" -ne 7 ]]
}
# 'docker run --detach' only proves the container process was created. Wait until it remains
# running and every declared port accepts a connection before publishing the ready marker;
# otherwise a crash-looping container is recorded as a successful deployment forever.
service_is_ready() {
  [[ "$(docker inspect --format '{{.State.Running}}' marshal-service 2>/dev/null)" == "true" ]] || return 1
  ${portChecks}
}
SERVICE_READY=0
for attempt in $(seq 1 120); do
  if service_is_ready; then SERVICE_READY=1; break; fi
  sleep 2
done
if [[ "$SERVICE_READY" -ne 1 ]]; then echo 'MARSHAL_SERVICE_NOT_READY'; exit 1; fi
readonly RESOLVED_IMAGE="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE")"
if [[ -z "$RESOLVED_IMAGE" ]]; then echo 'MARSHAL_SERVICE_IMAGE_UNRESOLVED'; exit 1; fi
echo "MARSHAL_IMAGE_REF $RESOLVED_IMAGE"
echo "MARSHAL_SERVICE_READY $REVISION"
`;
}

export function builderStartupScript(spec: BuilderVmSpec): string {
  // TODO(security): replace metadata delivery with a one-time, target-scoped secret broker.
  // The metadata firewall below is the immediate isolation boundary, but keeping secret
  // payloads out of persistent instance metadata removes the dangerous copy altogether.
  const fileCommands = spec.files.map((file) => {
    const directory = file.path.split("/").slice(0, -1).join("/") || "/";
    return `mkdir -p ${shellQuote(`/var/lib/marshal-files${directory}`)}\nprintf '%s' ${shellQuote(file.contentsBase64)} | base64 -d > ${shellQuote(`/var/lib/marshal-files${file.path}`)}`;
  }).join("\n");
  const mounts = [
    "/marshal-build.sh",
    "/marshal-targets.tsv",
    "/marshal-build-env",
    "/marshal-dockerfiles",
  ].map((path) => ["--volume", `/var/lib/marshal-files${path}:${path}`]).flat();
  const envArgs = Object.entries(spec.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return `#!/bin/bash
set -euo pipefail
${fileCommands}
mkdir -p /var/lib/marshal-buildkit
readonly ACCESS_TOKEN="$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
if [[ -z "$ACCESS_TOKEN" ]]; then echo 'MARSHAL_BUILD_FAILED: could not obtain Artifact Registry access token'; exit 1; fi
readonly REGISTRY_AUTH_B64="$(printf 'oauth2accesstoken:%s' "$ACCESS_TOKEN" | base64 | tr -d '\n')"
# The startup-script metadata contains every target's file bundle and callback credentials.
# Fetch the builder's registry token first, then make the metadata endpoint unreachable
# before any tenant-controlled build step runs. OUTPUT covers the privileged host-network
# builder; DOCKER-USER covers BuildKit's ordinary bridged executor networks.
#
# Port 80 ONLY, never the bare address: on Container-Optimized OS that same 169.254.169.254
# is also the DNS resolver, so rejecting all traffic to it takes out name resolution for the
# whole build — the very next image pull dies with "lookup registry-1.docker.io on
# 169.254.169.254:53: write: operation not permitted", and so would the tarball fetch and the
# Artifact Registry push. The metadata API this is isolating is HTTP on port 80, which is
# exactly what stays blocked. Verified against real GCP.
iptables -I OUTPUT -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT
iptables -I DOCKER-USER -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT
docker pull ${shellQuote(spec.image)}
BUILD_EXIT=0
docker run --rm --privileged --network host --name marshal-builder \
  --volume /var/lib/marshal-buildkit:/.marshal-buildkit-disk \
  ${[...mounts, ...envArgs].map(shellQuote).join(" ")} \
  --env "REGISTRY_AUTH_B64=$REGISTRY_AUTH_B64" \
  --entrypoint /bin/sh ${shellQuote(spec.image)} /marshal-build.sh || BUILD_EXIT=$?
shutdown -h now || true
exit "$BUILD_EXIT"
`;
}

export class ComputeClient {
  constructor(
    private readonly client: GcpClient,
    private readonly config: ComputeConfig,
  ) {}

  private projectUrl(path: string): string {
    return `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(this.config.projectId)}${path}`;
  }

  private async waitForOperation(value: unknown, timeoutMillis = 10 * 60 * 1000): Promise<void> {
    let operation = parseOperation(value);
    const startedAt = performance.now();
    while (operation.status !== "DONE") {
      if (performance.now() - startedAt >= timeoutMillis) throw new GcpApiError(408, operation.selfLink, "timed out waiting for Compute Engine operation");
      await delay(1000);
      operation = parseOperation(await this.client.request(operation.selfLink));
    }
    if (operation.errorMessage !== null) throw new GcpApiError(502, operation.selfLink, operation.errorMessage);
  }

  // Read-then-create is not atomic, and this runs on the first deploy into a namespace — so
  // two concurrent first deploys both observe a missing resource and both POST. Compute Engine
  // answers the loser with 409 ALREADY_EXISTS, which is the state this is asking for rather
  // than a reason to fail that deployment. Wait for the winner's resource to become readable
  // so callers can rely on it existing either way.
  private async createOrConverge(readUrl: string, collectionUrl: string, body: unknown): Promise<void> {
    if (await this.client.request(readUrl, { allow404: true }) !== null) return;
    try {
      await this.waitForOperation(await this.client.request(collectionUrl, { method: "POST", body }));
      return;
    } catch (error) {
      if (!(error instanceof GcpApiError) || error.status !== 409) throw error;
    }
    const startedAt = performance.now();
    while (await this.client.request(readUrl, { allow404: true }) === null) {
      if (performance.now() - startedAt >= 2 * 60 * 1000) {
        throw new GcpApiError(408, readUrl, "timed out waiting for a concurrently created Compute Engine resource");
      }
      await delay(1000);
    }
  }

  async ensureNetwork(): Promise<void> {
    const networkUrl = this.projectUrl(`/global/networks/${encodeURIComponent(this.config.network)}`);
    await this.createOrConverge(networkUrl, this.projectUrl("/global/networks"), {
      name: this.config.network,
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: "REGIONAL" },
    });
    const subnetUrl = this.projectUrl(`/regions/${encodeURIComponent(this.config.region)}/subnetworks/${encodeURIComponent(this.config.subnetwork)}`);
    await this.createOrConverge(subnetUrl, this.projectUrl(`/regions/${encodeURIComponent(this.config.region)}/subnetworks`), {
      name: this.config.subnetwork,
      network: networkUrl,
      ipCidrRange: "10.128.0.0/20",
      privateIpGoogleAccess: true,
      stackType: "IPV4_ONLY",
    });
    const firewallName = `${this.config.network}-internal`;
    const firewallUrl = this.projectUrl(`/global/firewalls/${encodeURIComponent(firewallName)}`);
    await this.createOrConverge(firewallUrl, this.projectUrl("/global/firewalls"), {
      name: firewallName,
      network: networkUrl,
      direction: "INGRESS",
      sourceRanges: ["10.128.0.0/20"],
      targetTags: ["hexclave-service"],
      allowed: [
        { IPProtocol: "tcp", ports: ["1-65535"] },
        { IPProtocol: "udp", ports: ["1-65535"] },
        { IPProtocol: "icmp" },
      ],
    });
  }

  async getDisk(name: string): Promise<ComputeDisk | null> {
    const result = await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/disks/${encodeURIComponent(name)}`), { allow404: true });
    return result === null ? null : parseDisk(result);
  }

  async ensureDisk(name: string, sizeGb: number): Promise<ComputeDisk> {
    const existing = await this.getDisk(name);
    if (existing === null) {
      await this.waitForOperation(await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/disks`), {
        method: "POST",
        body: { name, sizeGb: String(sizeGb), type: this.projectUrl(`/zones/${this.config.zone}/diskTypes/pd-standard`) },
      }));
    } else if (sizeGb > existing.sizeGb) {
      await this.waitForOperation(await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/disks/${encodeURIComponent(name)}/resize`), {
        method: "POST",
        body: { sizeGb: String(sizeGb) },
      }));
    } else if (sizeGb < existing.sizeGb) {
      throw new Error(`persistent disk ${name} is already ${existing.sizeGb}GB and cannot be shrunk to ${sizeGb}GB`);
    }
    return await this.getDisk(name) ?? throwError(`Compute Engine disk ${name} disappeared after reconciliation`);
  }

  async getInstance(name: string): Promise<ComputeInstance | null> {
    const result = await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/instances/${encodeURIComponent(name)}`), { allow404: true });
    return result === null ? null : parseInstance(result);
  }

  async applyInstance(spec: ComputeInstanceSpec): Promise<ComputeInstance> {
    const existing = await this.getInstance(spec.name);
    if (existing !== null && existing.revision === spec.revision && (existing.status === "RUNNING" || existing.status === "STAGING")) {
      const output = await this.getSerialOutput(spec.name);
      return { ...existing, imageRef: imageRefFromSerialOutput(output) };
    }
    if (existing !== null) await this.deleteInstance(spec.name);
    const networkUrl = this.projectUrl(`/global/networks/${encodeURIComponent(this.config.network)}`);
    const subnetUrl = this.projectUrl(`/regions/${encodeURIComponent(this.config.region)}/subnetworks/${encodeURIComponent(this.config.subnetwork)}`);
    await this.waitForOperation(await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/instances`), {
      method: "POST",
      body: {
        name: spec.name,
        machineType: this.projectUrl(`/zones/${this.config.zone}/machineTypes/e2-micro`),
        tags: { items: ["hexclave-service"] },
        labels: { "hexclave-managed": "true", "hexclave-revision": spec.revision, "hexclave-service-key": spec.serviceKeyHash },
        disks: [
          {
            boot: true,
            autoDelete: true,
            type: "PERSISTENT",
            initializeParams: {
              sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
              diskSizeGb: "10",
              diskType: this.projectUrl(`/zones/${this.config.zone}/diskTypes/pd-standard`),
            },
          },
          ...(spec.volume === null ? [] : [{
            boot: false,
            autoDelete: false,
            type: "PERSISTENT",
            deviceName: spec.volume.diskName,
            source: this.projectUrl(`/zones/${this.config.zone}/disks/${spec.volume.diskName}`),
          }]),
        ],
        networkInterfaces: [{
          network: networkUrl,
          subnetwork: subnetUrl,
          // Ephemeral egress address only. No ingress firewall permits Internet traffic to
          // the VM; public HTTP reaches it through the managed Cloud Run gateway.
          accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
        }],
        metadata: { items: [
          { key: "startup-script", value: serviceStartupScript(spec) },
          { key: "hexclave-revision", value: spec.revision },
          { key: "serial-port-logging-enable", value: "TRUE" },
        ] },
        serviceAccounts: [{ email: "default", scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
        scheduling: { automaticRestart: true, onHostMaintenance: "MIGRATE", provisioningModel: "STANDARD" },
        shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
        deletionProtection: false,
      },
    }), 5 * 60 * 1000);
    if (await this.getInstance(spec.name) === null) throwError(`Compute Engine instance ${spec.name} disappeared after creation`);
    const imageRef = await this.waitForServiceReady(spec.name, spec.revision);
    const ready = await this.getInstance(spec.name) ?? throwError(`Compute Engine instance ${spec.name} disappeared after becoming ready`);
    return { ...ready, imageRef };
  }

  // Compute Engine serializes serial-port reads PER INSTANCE and answers an overlapping
  // fetch with a 400 (SERIAL_PORT_OUTPUT_IN_PROGRESS). It is a "come back in a moment",
  // not a failure — but it reached callers as a fatal GcpApiError and failed the whole
  // deploy of a VM that was RUNNING and healthy. Two readers are enough to trigger it: the
  // readiness poll below and any concurrent observation of the same service.
  private async readSerialPort(name: string, options?: { allow404?: boolean }): Promise<unknown | null> {
    const url = this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/instances/${encodeURIComponent(name)}/serialPort?port=1`);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.request(url, options);
      } catch (error) {
        const contended = error instanceof GcpApiError
          && error.status === 400
          && error.providerMessage.includes("SERIAL_PORT_OUTPUT_IN_PROGRESS");
        if (!contended || attempt >= 5) throw error;
        await delay(1000);
      }
    }
  }

  async waitForServiceReady(name: string, revision: string): Promise<string> {
    const startedAt = performance.now();
    for (;;) {
      const output = await this.readSerialPort(name);
      if (!isRecord(output) || typeof output.contents !== "string") throw new Error(`Compute Engine returned invalid serial output for ${name}`);
      if (output.contents.includes(`MARSHAL_SERVICE_READY ${revision}`)) {
        return imageRefFromSerialOutput(output.contents) ?? throwError(`Compute Engine instance ${name} became ready without reporting its resolved image`);
      }
      // The startup script runs under `set -e`, so a failure there means the container will
      // never report ready. Say what actually happened instead of burning the full five
      // minutes and reporting a bare timeout with no cause.
      if (/Script "startup-script" failed/.test(output.contents)) {
        const tail = output.contents.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        const reason = serviceFailureReason(output.contents);
        throw new GcpApiError(502, `instances/${name}/serialPort`, reason === null
          ? `the service container failed to start; last serial output: ${tail}`
          : `the service container failed to start: ${reason}; last serial output: ${tail}`);
      }
      if (performance.now() - startedAt > 5 * 60 * 1000) throw new GcpApiError(408, `instances/${name}/serialPort`, "timed out waiting for the service container to become ready");
      await delay(2000);
    }
  }

  async getSerialOutput(name: string): Promise<string> {
    const output = await this.readSerialPort(name, { allow404: true });
    if (output === null) return "";
    if (!isRecord(output) || typeof output.contents !== "string") throw new Error(`Compute Engine returned invalid serial output for ${name}`);
    return output.contents;
  }

  async deleteInstance(name: string): Promise<void> {
    const result = await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/instances/${encodeURIComponent(name)}`), { method: "DELETE", allow404: true });
    if (result !== null) await this.waitForOperation(result, 5 * 60 * 1000);
  }

  async createBuilder(spec: BuilderVmSpec): Promise<ComputeInstance> {
    const existing = await this.getInstance(spec.name);
    if (existing !== null) return existing;
    const networkUrl = this.projectUrl(`/global/networks/${encodeURIComponent(this.config.network)}`);
    const subnetUrl = this.projectUrl(`/regions/${encodeURIComponent(this.config.region)}/subnetworks/${encodeURIComponent(this.config.subnetwork)}`);
    await this.waitForOperation(await this.client.request(this.projectUrl(`/zones/${encodeURIComponent(this.config.zone)}/instances`), {
      method: "POST",
      body: {
        name: spec.name,
        machineType: this.projectUrl(`/zones/${this.config.zone}/machineTypes/${spec.machineType}`),
        tags: { items: ["hexclave-builder"] },
        labels: { "hexclave-managed": "true", "hexclave-builder": "true" },
        disks: [{
          boot: true,
          autoDelete: true,
          type: "PERSISTENT",
          initializeParams: {
            sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
            diskSizeGb: String(spec.diskSizeGb),
            diskType: this.projectUrl(`/zones/${this.config.zone}/diskTypes/pd-standard`),
          },
        }],
        networkInterfaces: [{
          network: networkUrl,
          subnetwork: subnetUrl,
          accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
        }],
        metadata: { items: [
          { key: "startup-script", value: builderStartupScript(spec) },
          { key: "hexclave-builder", value: "true" },
          { key: "serial-port-logging-enable", value: "TRUE" },
        ] },
        serviceAccounts: [{ email: "default", scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
        // MIGRATE, not TERMINATE: Compute Engine rejects onHostMaintenance=TERMINATE on a
        // non-preemptible E2 instance ("e2 instances do not support onHostMaintenance=
        // TERMINATE unless they are preemptible"), and the builder is an e2-standard-2/4.
        // Live migration is transparent to the build; automaticRestart stays false so a
        // builder that dies is not silently resurrected behind the deployment's back.
        scheduling: { automaticRestart: false, onHostMaintenance: "MIGRATE", provisioningModel: "STANDARD" },
        shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
      },
    }), 5 * 60 * 1000);
    return await this.getInstance(spec.name) ?? throwError(`Compute Engine builder ${spec.name} disappeared after creation`);
  }
}

function throwError(message: string): never {
  throw new Error(message);
}
