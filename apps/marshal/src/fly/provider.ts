// The Fly.io runtime: one Fly app per service, machines for instances, volumes for disks,
// Fly certificates for custom domains, and the Fly logs API for logs. This is the default
// runtime — every namespace with no pin runs here — so everything in this file that
// derives a NAME from a service's identity (appNameForService, hostnameForService,
// flyVolumeName) is load-bearing for every existing tenant: change a derivation and every
// live app becomes an orphan. See fly/naming.ts.
import { createHash } from "node:crypto";
import { platformHostname } from "../platform-domain-names.js";
import { BASE_IMAGE, BUILDER_IMAGE, BUILD_DOCKERFILE_DIR, BUILD_ENV_DIR, BUILD_TIMEOUT_SECONDS, FLY_DEFAULT_MEMORY_MB, RAILPACK_CLI_SHA256, RAILPACK_CLI_URL, RAILPACK_FRONTEND_IMAGE, RAILPACK_BUILDKIT_TMPFS_SIZE, SOFT_CONCURRENCY_LIMIT, flyBuilderGuestFor, flyConfig, flyGuestFor, flyVolumeName, getConfig, memorySizesFor, resolveNamespaceOrg, serviceMemoryMb } from "../config.js";
import { buildCompletionPath, buildHarnessScript, computeWebhookToken, generatedDockerfile, type Builder } from "../builds.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isImageDigest, pinToDigest } from "../image-ref.js";
import { MutationOutcomeUnknownError } from "../mutation-safety.js";
import { fetchAllLogs, fetchLogPage } from "../logs.js";
import type { AttachDomainResult, RuntimeAddress, RuntimeObservation, RuntimeProvider } from "../provider.js";
import { ensurePublicIps, reconcilePublicIps, releasePublicIpsIfUnused } from "../public-networking.js";
import { ReconciliationLeaseLostError, type ReconciliationLeaseGuard } from "../reconciliation-lock.js";
import { redactBuildLogText } from "../redact-build-log.js";
import { assertServiceCanHoldADomain, desiredMachineCount, pinnedMachineCount, soleHttpPort, specIsPublic, specVolume, standardPortsHolderFor } from "../spec-helpers.js";
import { claimDomain, listDomainClaimsForService, presignValidatedUploadGet, readDomainClaim, readDomainClaimVersioned, readSpec, releaseDomainClaim, rewriteDomainClaim } from "../store.js";
import { portEntries, type DnsRecord, type DomainStatus, type PortEntry, type ServiceDomainState, type ServiceSpec, type StoredDeployment, type StoredSpec, type VolumeConfig } from "../types.js";
import { FlyApiError, FlyClient, flyClientForNamespaceOrg, type FlyCertificate, type FlyCertificateRequirements, type FlyMachine, type FlyVolume } from "./client.js";
import { appNameForService, builderAppName, builderNetworkName, hostnameForService, networkForNamespace } from "./naming.js";

function isReconciliationFencingError(error: unknown): boolean {
  return error instanceof ReconciliationLeaseLostError || error instanceof MutationOutcomeUnknownError;
}

function flyFor(ns: string): FlyClient {
  return flyClientForNamespaceOrg(resolveNamespaceOrg(ns));
}

function certificateIsVerified(certificate: FlyCertificate): boolean {
  return certificate.clientStatus === "Ready";
}

// ---------------------------------------------------------------------------
// Machine config

// The parts of a Fly machine config this module actually produces. Named rather
// than left as `Record<string, unknown>` so callers — the tests especially — can
// read `.services[].ports[].handlers` without a cast to get at it. Fly accepts
// far more than this; only what we send is described.
export type MachineConfig = {
  image: string,
  guest: { cpu_kind: string, cpus: number, memory_mb: number },
  env: Record<string, string>,
  // Present only when the spec names a start command. `exec` replaces the
  // image's ENTRYPOINT and CMD both — see ContainerConfig.start_command.
  init?: { exec: string[] },
  mounts?: { volume: string, path: string }[],
  metadata: Record<string, string>,
  services: {
    protocol: string,
    internal_port: number,
    autostop: string,
    autostart: boolean,
    ports: { port: number, handlers?: string[] }[],
    concurrency: { type: string, soft_limit: number },
  }[],
  [key: string]: unknown,
};

/**
 * A port's external bindings, deduplicated.
 *
 * The dedupe is load-bearing: a container that listens on 80 or 443 (the default
 * for most web images) would otherwise get that number twice in one entry, and
 * for 443 with CONFLICTING handlers — plain `http` from its own binding and
 * `tls,http` from the standard one — leaving which wins up to Fly.
 */
export function externalPortsFor(entry: PortEntry, standardPortsHolder: number | null, isPublic: boolean): { port: number, handlers?: string[] }[] {
  if (entry.protocol !== "http") return [{ port: entry.port }];
  const bindings = new Map<number, { port: number, handlers?: string[] }>();
  // Its own number first, so a second HTTP port stays addressable...
  //
  // A PUBLIC SERVICE terminates TLS on that number, a private one does not. The
  // distinction is not cosmetic: on a public service a non-holder port's own
  // number is the ONLY way to reach it (the standard 80/443 belong to the
  // holder), so leaving it plain would put a port the author asked to publish on
  // the internet in cleartext — and the URL we hand back for it says https. A
  // private service is reached over Flycast as `http://<host>:<port>`, and
  // adding TLS there would break every private url() instead.
  bindings.set(entry.port, { port: entry.port, handlers: isPublic ? ["tls", "http"] : ["http"] });
  if (entry.port === standardPortsHolder) {
    // ...but the standard ports win the collision: 443 must terminate TLS, and
    // 80 stays plain HTTP (no force_https) because a private url() is http.
    bindings.set(80, { port: 80, handlers: ["http"] });
    bindings.set(443, { port: 443, handlers: ["tls", "http"] });
  }
  return [...bindings.values()];
}

export function machineConfigForSlot(options: {
  imageRef: string,
  spec: ServiceSpec,
  revision: string,
  ns: string,
  key: string,
  slot: number,
  env: Record<string, string>,
  volumeId: string | null,
}): MachineConfig {
  const pinned = options.slot < pinnedMachineCount(options.spec);
  const volume = specVolume(options.spec)?.volume;
  const standardPortsHolder = standardPortsHolderFor(options.spec.config.ports, options.spec.config.public);
  const config = {
    image: options.imageRef,
    // Derived from the spec's memory. Absent memory resolves to the 512MB shared guest every
    // Fly service ran on before sizes existed, so a service that has never named a size keeps
    // the machine it always had — and, because the same absence keeps its revision
    // unchanged, a same-spec reconcile does not roll it either.
    guest: flyGuestFor(serviceMemoryMb("fly", options.spec)),
    env: options.env,
    // A start command replaces what the image starts, entrypoint included: `exec`
    // is the only one of Fly's three init fields that does. (`cmd` alone is
    // passed TO the image's entrypoint as arguments — verified against real Fly
    // with nginx, whose docker-entrypoint.sh then ran the command as if it were
    // its own arguments.) Absent when there is none, so a spec without one hashes
    // and behaves exactly as before this existed.
    ...(options.spec.config.start_command !== undefined
      ? { init: { exec: ["/bin/sh", "-c", options.spec.config.start_command] } }
      : {}),
    // Only slot 0 can carry the volume, and a volume-backed spec is single-slot anyway
    // (type "server", enforced in validateServiceSpec). The volume id is part of the
    // hashed config on purpose: if the volume were ever replaced, the machine must roll onto
    // the new one rather than silently keep the old mount.
    ...(volume !== undefined && options.volumeId !== null && options.slot === 0
      ? { mounts: [{ volume: options.volumeId, path: volume.path }] }
      : {}),
    metadata: {
      hexclave_ns: options.ns,
      hexclave_key: options.key,
      hexclave_revision: options.revision,
      hexclave_slot: String(options.slot),
    },
    restart: { policy: "on-failure", max_retries: 2 },
    // One Fly services entry per declared port. Every port is reachable at its
    // OWN number (that is what makes several ports addressable at all), and the
    // service's single HTTP port additionally answers on 80/443 so its fly.dev
    // URL and any custom domain certificate work on the standard ports.
    services: portEntries(options.spec.config.ports).map((entry) => ({
      protocol: "tcp",
      internal_port: entry.port,
      // Pinned machines never autostop; the rest scale to zero and Fly Proxy autostarts
      // them on demand (only *existing* machines get autostarted, which is why the full
      // max_instances fleet is pre-created).
      //
      // A "server" SUSPENDS instead of stopping: it resumes with its memory intact and
      // without a cold start, and Fly leaves an attached volume and its data untouched
      // across suspend/resume. Suspend is only advisable at <= 2 GB of memory; larger
      // servers still ask for it, and Fly falls back to a stop where it cannot suspend.
      // A "serverless" stops, so each start is cold from a clean rootfs.
      autostop: pinned ? "off" : options.spec.config.type === "server" ? "suspend" : "stop",
      autostart: true,
      ports: externalPortsFor(entry, standardPortsHolder, options.spec.config.public),
      concurrency: {
        type: entry.protocol === "http" ? "requests" : "connections",
        soft_limit: SOFT_CONCURRENCY_LIMIT,
      },
    })),
  };
  // The config hash makes re-applies cheap no-ops and catches resolved-ref drift that the
  // revision (hashed over UNresolved env) deliberately ignores.
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
  return { ...config, metadata: { ...config.metadata, hexclave_config_hash: hash } };
}

// ---------------------------------------------------------------------------
// Volumes

// Fly does NOT enforce unique volume names within an app. The reconciliation lease prevents
// Marshal replicas from creating concurrently, but a process can still die after Fly accepts
// a create and before the bucket records the outcome. These helpers make recovery
// DETERMINISTIC — the currently-attached volume first, then the oldest id — so every later
// apply converges on the same disk. Choosing arbitrarily is the dangerous case: it would roll
// the machine onto another volume and the service would come up with an empty disk, which
// reads to the tenant as total data loss. Volumes being destroyed are never candidates.
export function candidateVolumes(volumes: FlyVolume[], volumeId: string): FlyVolume[] {
  const name = flyVolumeName(volumeId);
  return volumes
    .filter((candidate) => candidate.name === name && candidate.state !== "destroying" && candidate.state !== "pending_destruction")
    .sort((a, b) => {
      if ((a.attached_machine_id !== null) !== (b.attached_machine_id !== null)) return a.attached_machine_id !== null ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export function selectCanonicalVolume(volumes: FlyVolume[], volumeId: string): FlyVolume | null {
  const candidates = candidateVolumes(volumes, volumeId);
  return candidates.length === 0 ? null : candidates[0];
}

// Idempotently brings the service's single volume to the configured size, returning its id.
// Created BEFORE any machine: Fly places a machine on its volume's host, and creating the
// machine first would usually land it on a different host (then the mount fails).
async function ensureVolume(fly: FlyClient, appName: string, volumeId: string, volume: VolumeConfig, lease: ReconciliationLeaseGuard): Promise<string> {
  const config = flyConfig();
  const candidates = candidateVolumes(await fly.listVolumes(appName), volumeId);
  if (candidates.length === 0) {
    await lease.assertOwned();
    const created = await fly.createVolume(appName, { name: flyVolumeName(volumeId), region: config.region, size_gb: volume.size_gb });
    await fly.waitForVolumeListed(appName, created.id);
    // Re-list and re-select rather than trusting our own create. Two concurrent
    // applies can both see an empty list and both create a volume (Fly does not
    // enforce unique names), and if each then mounted the disk it made, the service
    // would come up as two machines backed by DIVERGENT data — writes split across
    // two disks, unmergeable. Re-selecting with the same deterministic rule makes
    // both applies converge on one canonical volume; the loser's create is orphaned
    // (logged below), and whichever apply gets there second is refused by Fly's
    // "volume already claimed" 412 instead of silently diverging.
    const canonical = selectCanonicalVolume(await fly.listVolumes(appName), volumeId);
    if (canonical === null) return created.id; // list raced the create; ours is all we know of
    if (canonical.id !== created.id) {
      console.error(`volume create race on ${appName}: adopted ${canonical.id}, orphaning ${created.id} (needs manual cleanup)`);
      // The orphan may be smaller than requested; the adopted one still has to grow.
      if (volume.size_gb > canonical.size_gb) {
        await lease.assertOwned();
        await fly.extendVolume(appName, canonical.id, volume.size_gb);
      }
    }
    return canonical.id;
  }
  const existing = candidates[0];
  if (volume.size_gb > existing.size_gb) {
    await lease.assertOwned();
    await fly.extendVolume(appName, existing.id, volume.size_gb);
  } else if (volume.size_gb < existing.size_gb) {
    // Fly volumes are grow-only, and shrinking would mean destroying tenant data. Fail the
    // deploy rather than silently ignoring the requested size: a no-op here would leave the
    // config claiming a size the service does not have and the tenant billed for the larger
    // disk, with nothing anywhere reporting the divergence.
    throw badRequest(
      `the volume is already ${existing.size_gb}GB and cannot be shrunk to ${volume.size_gb}GB (disks can only grow). `
      + `Set the volume size back to at least ${existing.size_gb}GB, or remove the volume from this service and redeploy to detach it — the existing disk is kept either way.`,
    );
  }
  return existing.id;
}

// Mount sets are compared by (volume id, path), order-insensitively. Any difference means
// the machine has to be recreated rather than updated — see the call site.
function mountsDiffer(a: { volume: string, path: string }[], b: { volume: string, path: string }[]): boolean {
  if (a.length !== b.length) return true;
  const key = (mount: { volume: string, path: string }) => `${mount.volume}\0${mount.path}`;
  const inA = new Set(a.map(key));
  return b.some((mount) => !inA.has(key(mount)));
}

/**
 * The digest Fly reports for a machine, or null when it reports nothing usable.
 *
 * VALIDATED, not merely null-checked. `image_ref.digest` is optional and typed
 * as a plain string, so an empty or malformed one is inside its declared type —
 * and `??` is nullish-only, so `""` would sail past a null check and compose
 * into `docker.io/library/redis@`: a reference recorded as "what ran" that names
 * nothing. The null the callers already handle is the right answer for anything
 * that is not a digest.
 */
export function reportedDigest(machine: FlyMachine): string | null {
  const digest = machine.image_ref?.digest;
  return digest !== undefined && isImageDigest(digest) ? digest : null;
}

// ---------------------------------------------------------------------------
// Machine reconciliation

// Machine states in which `/start` is accepted. Anything else is a transition (`replacing`,
// `starting`, `stopping`, `suspending`, ...) that Fly rejects a start against.
const STARTABLE_MACHINE_STATES = new Set(["stopped", "suspended", "created"]);

/**
 * Starts a machine that is not running, tolerating the transition Fly puts it through first.
 *
 * `/start` is rejected while a machine is mid-transition (real Fly: `412 unable to start
 * machine from current state: 'replacing'`), and a stopped or suspended machine that was JUST
 * updated is exactly that for a few seconds — the update answers before Fly has finished
 * swapping the image, and it deliberately leaves the new version stopped ("machine was in a
 * non-started state prior to the update"). Firing `/start` once at that moment gets it
 * rejected, nothing ever boots, and the started-wait that follows burns its whole budget on a
 * machine nobody asked to start: that is how every redeploy onto an autosuspended
 * `min_instances: 0` server failed with "did not start in time" while the same image booted
 * fine seconds later on the first inbound request.
 *
 * So: poll until the machine is either already coming up or in a state a start is accepted
 * from, then start it, retrying a rejected start until `budgetMillis` runs out. Gives up
 * quietly after that — the caller's started-wait remains the arbiter of whether the boot
 * actually happened, and this only decides whether one was requested.
 */
export async function startMachineWhenSettled(
  fly: Pick<FlyClient, "getMachine" | "startMachine">,
  appName: string,
  machineId: string,
  lease: ReconciliationLeaseGuard,
  options?: { budgetMillis?: number, pollMillis?: number },
): Promise<void> {
  const deadline = Date.now() + (options?.budgetMillis ?? 30_000);
  const pollMillis = options?.pollMillis ?? 1000;
  let lastError: unknown = null;
  for (;;) {
    const machine = await fly.getMachine(appName, machineId);
    // Destroyed underneath us: nothing to start; the wait will report it.
    if (machine === null) return;
    if (machine.state === "started" || machine.state === "starting") return;
    if (STARTABLE_MACHINE_STATES.has(machine.state)) {
      try {
        await lease.assertOwned();
        await fly.startMachine(appName, machineId);
        return;
      } catch (error) {
        if (isReconciliationFencingError(error)) throw error;
        // A rejected start is the transition race above, or Fly already booting it (the next
        // poll sees `starting`). Anything else is worth a record, since the wait's eventual
        // timeout is all the caller will otherwise ever see of it.
        lastError = error;
      }
    }
    if (Date.now() >= deadline) {
      console.error(`gave up requesting a start for ${appName}/${machineId} (last state ${JSON.stringify(machine.state)})`, lastError);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMillis));
  }
}

/**
 * Rolls the service's machines onto `imageRef`, and reports the image Fly says
 * slot 0 is actually running.
 *
 * The two differ whenever `imageRef` names a tag: Marshal does not resolve
 * images, so the digest Fly reports back is the only record of which bytes the
 * tag pointed at. Slot 0 because it is the one machine every service has, and
 * because a mid-roll tag move would make the later slots disagree — which is a
 * property of tags, not something a second read here could fix.
 *
 * Null when Fly reports no digest (the mock Fly before it grew `image_ref`, or
 * a machine the roll left untouched and unread); callers fall back to the
 * reference as written.
 */
async function applyMachines(fly: FlyClient, stored: StoredSpec, imageRef: string, env: Record<string, string>, lease: ReconciliationLeaseGuard): Promise<string | null> {
  const config = getConfig();
  const flyConfiguration = flyConfig();
  const appName = appNameForService(config.envId, stored.ns, stored.key);
  const network = networkForNamespace(config.envId, stored.ns);
  const t0 = Date.now();
  const t = (label: string) => console.log(`${new Date().toISOString()} timing applyMachines ${stored.ns}/${stored.key} ${label} +${Date.now() - t0}ms`);
  await lease.assertOwned();
  await fly.ensureApp(appName, network);
  t("ensureApp");
  await lease.assertOwned();
  // SPIKE: the two address reconciliations only need the app to exist; neither the
  // machine nor the other one depends on them, so they run side by side.
  await Promise.all([
    fly.ensureFlycastIp(appName, network),
    reconcilePublicIps(fly, appName, specIsPublic(stored.spec) ? "public" : "private"),
  ]);
  t("flycast + public IPs reconciled");

  const specVolumeEntry = specVolume(stored.spec);
  const volumeId = specVolumeEntry === null
    ? null
    : await ensureVolume(fly, appName, specVolumeEntry.volumeId, specVolumeEntry.volume, lease);

  const machines = await fly.listMachines(appName);
  const bySlot = new Map<number, FlyMachine>();
  let extras: FlyMachine[] = [];
  for (const machine of machines) {
    const slot = Number(machine.config.metadata?.hexclave_slot);
    if (Number.isInteger(slot) && slot >= 0 && !bySlot.has(slot)) {
      bySlot.set(slot, machine);
    } else {
      extras.push(machine);
    }
  }

  // A volume can only be claimed by one machine, so any leftover machine still holding it
  // must go BEFORE the slot loop tries to mount it — otherwise slot 0's create/update gets
  // Fly's 412 "volume already claimed", applyMachines throws before reaching the destroy
  // loop below, and every retry reproduces it identically (a permanently wedged service).
  // Scoped to claim-holders only: reordering the whole destroy loop would break the rolling
  // guarantee documented below.
  if (volumeId !== null) {
    const holdsVolume = (machine: FlyMachine) => (machine.config.mounts ?? []).some((mount) => mount.volume === volumeId);
    const claimHolders = extras.filter(holdsVolume);
    for (const machine of claimHolders) {
      await lease.assertOwned();
      await fly.destroyMachine(appName, machine.id);
    }
    extras = extras.filter((machine) => !holdsVolume(machine));
  }

  const count = desiredMachineCount(stored.spec);
  // Fly's resolution of `imageRef` for slot 0 — see this function's doc comment.
  // Assigned directly in each branch rather than through a helper: a closure
  // hides the assignment from TypeScript's control flow, which then reads the
  // return below as dead code.
  let runningDigest: string | null = null;
  // Rolling, one machine at a time with a started-wait between: a bad image fails on slot 0
  // and leaves the rest serving the old revision.
  for (let slot = 0; slot < count; slot++) {
    const desired = machineConfigForSlot({ imageRef, spec: stored.spec, revision: stored.revision, ns: stored.ns, key: stored.key, slot, env, volumeId });
    const desiredHash = desired.metadata.hexclave_config_hash;
    let existing = bySlot.get(slot);
    bySlot.delete(slot);

    // A machine's MOUNTS cannot be changed in place. Fly places a machine on its volume's
    // host, so an already-placed machine can't adopt a volume that was created afterwards:
    // real Fly rejects the update with `400 invalid_argument: volume does not exist`, even
    // once the volume is listed and `created` (verified against real Fly). Left to
    // the update path, adding a volume to a deployed service would fail identically on every
    // retry and wedge it forever. Destroy first so the branch below recreates it on the
    // volume's host. Detaching is recreated too: the reverse transition is equally unproven,
    // and the volume itself always survives.
    if (existing !== undefined && mountsDiffer(existing.config.mounts ?? [], desired.mounts ?? [])) {
      await lease.assertOwned();
      await fly.destroyMachine(appName, existing.id);
      existing = undefined;
    }

    const existingStarted = existing !== undefined && (existing.state === "started" || existing.state === "starting");
    // Config-hash match short-circuits — but only when the machine is actually up. A pinned
    // (autostop:"off") slot that crash-looped to `stopped` will never be restarted by Fly
    // Proxy, so a same-spec reconcile must still boot it; otherwise an always-on service
    // stays down forever. Autostoppable slots are meant to be stopped, so leave those.
    const pinned = slot < pinnedMachineCount(stored.spec);
    if (existing !== undefined && existing.config.metadata?.hexclave_config_hash === desiredHash && (existingStarted || !pinned)) {
      if (slot === 0) runningDigest = reportedDigest(existing);
      continue;
    }
    if (existing !== undefined && existing.config.metadata?.hexclave_config_hash === desiredHash) {
      // Hash matches but a pinned machine is stopped: just start it, no config churn.
      await startMachineWhenSettled(fly, appName, existing.id, lease);
      await fly.waitForMachineState(appName, existing.id, "started", { instanceId: existing.instance_id, totalTimeoutSeconds: 120 });
      if (slot === 0) runningDigest = reportedDigest(existing);
      continue;
    }
    if (existing !== undefined) {
      const wasStopped = existing.state !== "started" && existing.state !== "starting";
      await lease.assertOwned();
      const updated = await fly.updateMachine(appName, existing.id, desired);
      if (wasStopped) {
        // Updating a stopped (or autosuspended) machine leaves it stopped; start explicitly so
        // the started-wait below actually gates the roll (autostop re-stops it when idle).
        // Not a bare `/start`: the update is still settling when it answers, and Fly rejects
        // a start until it has — see startMachineWhenSettled.
        await startMachineWhenSettled(fly, appName, updated.id, lease);
      }
      await fly.waitForMachineState(appName, updated.id, "started", { instanceId: updated.instance_id, totalTimeoutSeconds: 120 });
      if (slot === 0) runningDigest = reportedDigest(updated);
    } else {
      await lease.assertOwned();
      const created = await fly.createMachine(appName, {
        name: `${stored.key.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20)}-${slot}`,
        region: flyConfiguration.region,
        config: desired,
      });
      t(`createMachine ${created.id}`);
      await fly.waitForMachineState(appName, created.id, "started", { instanceId: created.instance_id, totalTimeoutSeconds: 120 });
      t("machine started");
      if (slot === 0) runningDigest = reportedDigest(created);
    }
  }
  for (const machine of [...bySlot.values(), ...extras]) {
    await lease.assertOwned();
    await fly.destroyMachine(appName, machine.id);
  }
  return runningDigest === null ? null : pinToDigest(imageRef, runningDigest);
}

// ---------------------------------------------------------------------------
// Addresses and domains

async function serviceAddress(fly: FlyClient, ns: string, key: string, stored: StoredSpec, certificates?: FlyCertificate[]): Promise<RuntimeAddress> {
  const { envId } = getConfig();
  const appName = appNameForService(envId, ns, key);
  const hostname = hostnameForService(envId, ns, key);
  const httpPort = soleHttpPort(stored.spec.config.ports);
  const servesHttp = portEntries(stored.spec.config.ports).some((entry) => entry.protocol === "http");
  // Keep a public service's platform URL stable even while custom domains are added or
  // removed. The backend prefers a verified custom domain for display, then falls back to
  // this value; private services continue to expose only a verified custom domain.
  let platformUrl: string | null = null;
  if (servesHttp) {
    if (specIsPublic(stored.spec)) {
      platformUrl = `https://${platformHostname(envId, ns, key)}`;
    } else {
      const verified = (certificates ?? await fly.listCertificates(appName)).filter(certificateIsVerified).map((certificate) => certificate.hostname).sort();
      platformUrl = verified.length > 0 ? `https://${verified[0]}` : null;
    }
  }
  return {
    hostname,
    privateHost: hostname,
    // The private address of the service's sole HTTP port. Null when it declares several and
    // so leaves a bare `url()` ambiguous — a ref that names its port resolves independently.
    internalUrl: httpPort === null ? null : `http://${hostname}:${httpPort}`,
    platformUrl,
  };
}

/**
 * The DNS a user must create, taken from what FLY says the hostname needs rather than
 * re-derived from the app's IPs.
 *
 * The ownership TXT is emitted unconditionally while the hostname is unverified, not only
 * when we detect a proxy. Fly accepts any ONE of three proofs — an AAAA pointing at the app,
 * the `_acme-challenge` CNAME, or `_fly-ownership` — and the first two are exactly the two a
 * CDN proxy breaks: the proxy answers A/AAAA with its own anycast addresses and terminates
 * TLS, so the AAAA proof and TLS-ALPN-01 both fail. Since the ownership TXT is the only proof
 * that survives proxying, is harmless when the other proofs also succeed, and cannot be
 * guessed after the fact, showing it always beats making the user diagnose which case they
 * are in. Ordered ownership-first for the same reason.
 */
export function dnsRecordsForRequirements(requirements: FlyCertificateRequirements): DnsRecord[] {
  const { hostname, dns_requirements: dns } = requirements;
  if (requirementsAreVerified(requirements)) return [];
  const records: DnsRecord[] = [
    // app_value, never org_value — see FlyCertificateRequirements. org_value would prove
    // ownership to every app in the platform's Fly org, i.e. to every other tenant.
    { type: "TXT", name: dns.ownership.name, value: dns.ownership.app_value },
  ];
  // Fly reports `a`/`aaaa` for an apex and `cname` for a subdomain, and populates both
  // regardless; which one to USE is the apex question. An apex cannot hold a CNAME.
  if (isApexHostname(hostname)) {
    for (const address of dns.a) records.push({ type: "A", name: hostname, value: address });
    for (const address of dns.aaaa) records.push({ type: "AAAA", name: hostname, value: address });
  } else {
    records.push({ type: "CNAME", name: hostname, value: dns.cname });
  }
  // Pre-issuance DNS validation: lets the cert issue before (or without) the main
  // record cutting over.
  records.push({ type: "CNAME", name: dns.acme_challenge.name, value: dns.acme_challenge.target });
  return records;
}

// Fly's own `isApex` lives on the GraphQL certificate, which the requirements read does not
// fetch. The label count is the same test Fly applies and needs no extra round trip.
function isApexHostname(hostname: string): boolean {
  return hostname.split(".").length <= 2;
}

function requirementsAreVerified(requirements: FlyCertificateRequirements): boolean {
  return requirements.status === "Ready";
}

/**
 * Derived from Fly's validation booleans rather than its status STRING, which is prose we do
 * not control. "issuing" = Fly has accepted a proof of ownership and is waiting on the CA;
 * that is the state the Fly dashboard shows as "Issuing", and the one a user otherwise
 * cannot tell apart from having done nothing at all.
 */
export function domainStatusForRequirements(requirements: FlyCertificateRequirements): DomainStatus {
  if (requirementsAreVerified(requirements)) return "verified";
  const validation = requirements.validation;
  const anyProofAccepted = validation.dns_configured
    || validation.alpn_configured
    || validation.http_configured
    || validation.ownership_txt_configured;
  return anyProofAccepted ? "issuing" : "awaiting_dns";
}

/**
 * Fly's own remediation text for why a hostname is not verified yet, or null while nothing
 * is wrong. Surfaced instead of discarded because "Awaiting configuration" alone gives the
 * user nothing to act on.
 */
export function domainErrorForRequirements(requirements: FlyCertificateRequirements): string | null {
  if (requirementsAreVerified(requirements)) return null;
  // Length-checked rather than compared against undefined: the index signature is not
  // optional under this tsconfig, so the comparison lints as a no-overlap check even though
  // an empty array really does yield undefined at runtime.
  if (requirements.validation_errors.length === 0) return null;
  const first = requirements.validation_errors[0];
  return first.remediation || first.message || null;
}

// Falls back to the GraphQL certificate when Fly has no requirements to report (the
// certificate was deleted between the two reads). The hostname is still attached from
// Marshal's point of view, so it must report a state rather than throw.
function domainStateWithoutRequirements(certificate: FlyCertificate): ServiceDomainState {
  return {
    hostname: certificate.hostname,
    verified: certificateIsVerified(certificate),
    status: certificateIsVerified(certificate) ? "verified" : "awaiting_dns",
    dns_records: [],
    error: null,
  };
}

export async function computeDomainStates(fly: FlyClient, appName: string, certificates: FlyCertificate[]): Promise<ServiceDomainState[]> {
  if (certificates.length === 0) return [];
  const sorted = certificates.slice().sort((a, b) => a.hostname < b.hostname ? -1 : 1);
  // One read per hostname. Bounded by the number of domains on ONE service (single digits in
  // practice), and it replaces the getAppIps call this used to make, so a single-domain
  // service costs the same number of round trips as before.
  return await Promise.all(sorted.map(async (certificate) => {
    const requirements = await fly.getCertificateRequirements(appName, certificate.hostname);
    if (requirements === null) return domainStateWithoutRequirements(certificate);
    return {
      hostname: certificate.hostname,
      verified: requirementsAreVerified(requirements),
      status: domainStatusForRequirements(requirements),
      dns_records: dnsRecordsForRequirements(requirements),
      error: domainErrorForRequirements(requirements),
    };
  }));
}

async function releaseServicePublicIpsIfUnused(ns: string, serviceKey: string): Promise<void> {
  const config = getConfig();
  const fly = flyFor(ns);
  const appName = appNameForService(config.envId, ns, serviceKey);
  const spec = await readSpec(ns, serviceKey);
  await releasePublicIpsIfUnused(fly, appName, spec !== null && specIsPublic(spec.spec));
}

// Fly does NOT enforce hostname uniqueness across apps (smoke-verified), so the bucket
// domain registry is the arbiter: a hostname belongs to exactly one (ns, service) claim,
// established with an atomic conditional PUT. Fly certs remain the source of truth for
// verification state; the registry only answers "who owns this hostname".
async function attachDomain(ns: string, hostname: string, serviceKey: string): Promise<AttachDomainResult> {
  const config = getConfig();
  const fly = flyFor(ns);
  const appName = appNameForService(config.envId, ns, serviceKey);
  const stored = await readSpec(ns, serviceKey);
  if (stored === null) {
    throw notFound(`service ${JSON.stringify(serviceKey)} not found in namespace ${JSON.stringify(ns)}`);
  }
  assertServiceCanHoldADomain(serviceKey, stored.spec.config.ports, stored.spec.config.public, "Change the service's ports first, then attach the domain.");

  let existingClaim = await readDomainClaimVersioned(hostname);
  if (existingClaim === null) {
    const claimed = await claimDomain({ hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
    // Losing this race does NOT mean someone ELSE holds the hostname: two concurrent attaches
    // of the SAME hostname on the SAME service both read no claim and both try to create one,
    // which is the concurrent form of the replay the same-service branch below treats as
    // success. Re-read and let the ownership branches decide, so the loser reaches the same
    // answer a sequential replay does instead of a spurious conflict.
    if (!claimed) {
      existingClaim = await readDomainClaimVersioned(hostname);
      // Claimed and then released between the two reads: nobody owns it, and there is no
      // ownership left to reconcile against, so the caller's retry is the honest answer.
      if (existingClaim === null) throw conflict(`hostname ${JSON.stringify(hostname)} changed owners concurrently; retry the attach`);
    }
  }
  // Skipped entirely when this request created the claim itself: there is no prior owner to
  // reconcile against.
  if (existingClaim !== null) {
    if (existingClaim.value.ns !== ns) {
      // Never reveal which namespace holds it.
      throw conflict(`hostname ${JSON.stringify(hostname)} is already attached elsewhere`);
    } else if (existingClaim.value.service_key !== serviceKey) {
      // Re-PUT within the namespace repoints: certificate moves from the old service's app.
      //
      // OWNERSHIP TRANSFERS FIRST, teardown second. The conditional rewrite is the only step
      // that can lose a race, and losing it after the teardown would leave the registry still
      // naming the previous service as owner while that service has already lost its TLS
      // termination and its public IPs — a state no later code path repairs. In this order a
      // failure after the rewrite leaves at worst an orphaned certificate on the old app, which
      // the next attach or detach on that app reconciles.
      const previousApp = appNameForService(config.envId, ns, existingClaim.value.service_key);
      const rewritten = await rewriteDomainClaim(existingClaim, { hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
      if (!rewritten) throw conflict(`hostname ${JSON.stringify(hostname)} changed owners concurrently; retry the attach`);
      await fly.deleteCertificate(previousApp, hostname);
      await releaseServicePublicIpsIfUnused(ns, existingClaim.value.service_key);
    } else {
      // Idempotent re-attach on the same service: re-assert the index entry, which repairs the
      // case where a prior claim landed but its index write was lost (an orphaned claim that
      // deleteService could otherwise never release).
      await claimDomain(existingClaim.value);
    }
  }

  // A custom domain needs the same public ingress as `public: true`: allocate the shared
  // IPv4 + dedicated IPv6 on first attach. Concurrent attaches of different hostnames on
  // the same app can both observe no IP and both allocate a second dedicated v6 — a minor
  // over-allocation the last-detach release reclaims.
  await ensurePublicIps(fly, appName);

  let certificate;
  try {
    certificate = await fly.addCertificate(appName, hostname);
  } catch (error) {
    // Same-app re-adds error with "already exists on app" — idempotent re-PUT, read it back.
    if (error instanceof FlyApiError && /already exists/i.test(error.flyMessage)) {
      certificate = await fly.getCertificate(appName, hostname);
      if (certificate === null) throw error;
    } else {
      throw error;
    }
  }

  return await domainResultFor(fly, appName, hostname, serviceKey, certificate);
}

/**
 * The attach/read answer for one hostname, built from Fly's certificate requirements.
 *
 * Shared by both callers so a hostname reports the same records however it was reached —
 * the earlier split let the attach response and the later polls disagree.
 */
async function domainResultFor(
  fly: FlyClient,
  appName: string,
  hostname: string,
  serviceKey: string,
  certificate: FlyCertificate,
): Promise<AttachDomainResult> {
  const requirements = await fly.getCertificateRequirements(appName, hostname);
  if (requirements === null) {
    const state = domainStateWithoutRequirements(certificate);
    return { hostname, service_key: serviceKey, verified: state.verified, status: state.status, dns_records: state.dns_records };
  }
  return {
    hostname,
    service_key: serviceKey,
    verified: requirementsAreVerified(requirements),
    status: domainStatusForRequirements(requirements),
    dns_records: dnsRecordsForRequirements(requirements),
  };
}

// Read-only counterpart to attachDomain: reports who owns the hostname and the current
// certificate state WITHOUT touching Fly. `attachDomain` is a repoint — using it as the
// "re-check verification now" primitive means merely reading one service's domain silently
// steals the certificate back from whichever service currently holds the hostname.
async function readDomain(ns: string, hostname: string): Promise<AttachDomainResult> {
  const config = getConfig();
  const fly = flyFor(ns);
  const claim = await readDomainClaim(hostname);
  if (claim === null || claim.ns !== ns) {
    throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  }
  const appName = appNameForService(config.envId, ns, claim.service_key);
  const certificate = await fly.getCertificate(appName, hostname);
  if (certificate === null) {
    // Claimed in the registry but no cert on the app: the runtime state was reset (or the
    // app was rebuilt) — same 404 the callers already translate into "deploy first".
    throw notFound(`hostname ${JSON.stringify(hostname)} has no certificate on service ${JSON.stringify(claim.service_key)}`);
  }
  return await domainResultFor(fly, appName, hostname, claim.service_key, certificate);
}

// `expectedServiceKey` fences a stale detach: when the hostname has since been repointed to
// another service in this namespace, removing it on behalf of the OLD service would tear down
// the new owner's live certificate. Treated as already-detached (404) instead.
async function detachDomain(ns: string, hostname: string, expectedServiceKey?: string): Promise<void> {
  const config = getConfig();
  const fly = flyFor(ns);
  const claim = await readDomainClaimVersioned(hostname);
  if (claim === null || claim.value.ns !== ns) {
    throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  }
  if (expectedServiceKey !== undefined && claim.value.service_key !== expectedServiceKey) {
    throw notFound(`hostname ${JSON.stringify(hostname)} is not attached to service ${JSON.stringify(expectedServiceKey)} in namespace ${JSON.stringify(ns)}`);
  }
  const appName = appNameForService(config.envId, ns, claim.value.service_key);
  await fly.deleteCertificate(appName, hostname);
  // Release public IPs BEFORE the claim: a crash between the two must not leave a billable
  // dedicated IP allocated with no claim (and no code path that would ever revisit it). The
  // service stays running and internally reachable; only its public exposure goes away when
  // the last domain detaches.
  await releaseServicePublicIpsIfUnused(ns, claim.value.service_key);
  await releaseDomainClaim(claim);
}

// ---------------------------------------------------------------------------
// The builder

function createFlyBuilder(): Builder {
  return {
    name: "fly",
    async startBuild(options, lease) {
      const config = getConfig();
      const flyConfiguration = flyConfig();
      if (config.publicUrl === null) {
        throw new Error("MARSHAL_PUBLIC_URL must be set for real Fly builds — the builder machine calls the completion webhook on it");
      }
      const fly = flyFor(options.ns);
      const serviceNetwork = networkForNamespace(config.envId, options.ns);

      // Fly's registry repositories are app-scoped: pushing
      // registry.fly.io/<app>:<tag> fails with "app repository not found" until the app
      // exists. Builds happen before applyMachines (which also ensures the app), so create
      // every built target's app here before starting BuildKit. A failed build may leave an
      // empty app, but it remains owned by the synced service and the ordinary service-delete
      // path removes it; the next deploy simply reuses it.
      for (const target of options.targets) {
        await lease.assertOwned();
        await fly.ensureApp(appNameForService(config.envId, options.ns, target.serviceKey), serviceNetwork);
      }

      const builderApp = builderAppName(config.envId);
      await lease.assertOwned();
      await fly.ensureApp(builderApp, builderNetworkName(config.envId));

      const tarballUrl = await presignValidatedUploadGet(options.ns, options.deploymentId, BUILD_TIMEOUT_SECONDS + 60);
      const webhookToken = computeWebhookToken(options.deploymentId, options.ns);
      const webhookUrl = `${config.publicUrl}${buildCompletionPath(options.deploymentId)}?ns=${encodeURIComponent(options.ns)}`;

      // The tab-separated manifest the harness loops over. Every field has been
      // validated (service keys, image refs and paths contain no tabs, newlines
      // or control characters), which is what lets /bin/sh read it with `read`
      // instead of parsing JSON without jq.
      const targetsManifest = options.targets
        .map((target) => [target.serviceKey, target.pushTarget, target.dockerfilePath ?? "", target.rootDirectory ?? ""].join("\t"))
        .join("\n");
      // A Railpack build needs the bigger guest; one machine builds every target,
      // so ANY auto-detected target decides the size for the whole run.
      //
      // A GENERATED Dockerfile is not one of them: it is an ordinary
      // FROM/COPY/RUN build like the author's own, with no railpack-builder base
      // image to extract and no plan to compute — so it gets the ordinary guest,
      // and a base-image target sitting next to a Railpack one still gets the big
      // one, because the machine is shared.
      const isRailpackBuild = options.targets.some((target) => target.dockerfilePath === null && target.baseImage === null);
      const guest = flyBuilderGuestFor({ requestedMemoryMb: options.builderMemoryMb, isRailpackBuild });
      await lease.assertOwned();
      const machine = await fly.createMachine(builderApp, {
        name: `build-${options.deploymentId.toLowerCase()}`,
        region: flyConfiguration.region,
        config: {
          image: BUILDER_IMAGE,
          guest,
          // One microVM per DEPLOYMENT = tenant isolation; auto_destroy reclaims it on exit
          // (logs survive destruction — smoke-verified). Every service of one deployment
          // source shares it, which is the point: they share a source tree, and a machine
          // per service would re-fetch and re-extract it for each.
          auto_destroy: true,
          restart: { policy: "no" },
          init: { exec: ["/bin/sh", "/marshal-build.sh"] },
          files: [
            {
              guest_path: "/marshal-build.sh",
              raw_value: Buffer.from(buildHarnessScript()).toString("base64"),
            },
            {
              guest_path: "/marshal-targets.tsv",
              raw_value: Buffer.from(`${targetsManifest}\n`, "utf8").toString("base64"),
            },
            // Tenant env, one directory per TARGET and one file per var. NOT in the env
            // block below: that one holds Marshal's org token and registry auth, and a
            // tenant value sitting next to them is one careless `env` away from being
            // logged as a credential — and one careless credential away from being handed
            // to `railpack prepare`, which runs unsandboxed in the harness.
            // An EMPTY value is skipped: it would mean a files entry whose raw_value is the
            // empty string, which the API is free to read as "no content supplied" rather
            // than "supplied, and empty". There is nothing to inline either way, and the
            // runtime env still carries the var — so the ambiguity is simply not worth
            // entering. The harness's `[ -f "$f" ]` guard makes the absence a non-event.
            ...options.targets.flatMap((target) => Object.entries(target.buildEnv).flatMap(([key, value]) => value === "" ? [] : [{
              guest_path: `${BUILD_ENV_DIR}/${target.serviceKey}/${key}`,
              raw_value: Buffer.from(value, "utf8").toString("base64"),
            }])),
            // The Dockerfiles Marshal generates, one directory per target. Their
            // PRESENCE is what selects the build kind in the harness, which is why
            // a target that needs neither contributes no file at all.
            //
            // Outside the build context on purpose: /ctx is the author's own
            // source, and anything written there would be swept up by their
            // `COPY . .`.
            ...options.targets.flatMap((target) => {
              const generated = generatedDockerfile(target);
              return generated === null ? [] : [{
                guest_path: `${BUILD_DOCKERFILE_DIR}/${target.serviceKey}/${generated.path}`,
                raw_value: Buffer.from(generated.contents, "utf8").toString("base64"),
              }];
            }),
          ],
          metadata: { marshal_deployment_id: options.deploymentId },
          env: {
            // Paths, not values: the harness reads the values out of the files above.
            BUILD_ENV_DIR,
            BUILD_DOCKERFILE_DIR,
            // The ext4 device Fly backs the rootfs overlay with, which it also mounts here: a
            // legal overlay upperdir when the tmpfs cannot be mounted. Named per runtime
            // because the GCP builder's disk lives elsewhere.
            BUILDKIT_DISK_DIR: "/.fly-upper-layer",
            TARBALL_URL: tarballUrl,
            REGISTRY_HOST: flyConfiguration.registryHost,
            REGISTRY_AUTH_B64: fly.registryAuthBase64(),
            WEBHOOK_URL: webhookUrl,
            WEBHOOK_TOKEN: webhookToken,
            BUILD_TIMEOUT_SECONDS: String(BUILD_TIMEOUT_SECONDS),
            RAILPACK_CLI_URL,
            RAILPACK_CLI_SHA256,
            RAILPACK_FRONTEND_IMAGE,
            ...(isRailpackBuild ? { BUILDKIT_TMPFS_SIZE: RAILPACK_BUILDKIT_TMPFS_SIZE } : {}),
          },
        },
      });
      return { builderApp, builderMachineId: machine.id };
    },
  };
}

// ---------------------------------------------------------------------------
// The provider

export function createFlyProvider(): RuntimeProvider {
  const provider: RuntimeProvider = {
    kind: "fly",
    createBuilder: createFlyBuilder,
    memorySizesMb: (type) => memorySizesFor("fly", type),
    defaultMemoryMb: () => FLY_DEFAULT_MEMORY_MB,

    async pushTarget(ns, serviceKey, deploymentId) {
      return `${flyConfig().registryHost}/${appNameForService(getConfig().envId, ns, serviceKey)}:${deploymentId.toLowerCase()}`;
    },

    builtImageRef(deployment, serviceKey, digest) {
      return `${flyConfig().registryHost}/${appNameForService(getConfig().envId, deployment.ns, serviceKey)}@${digest}`;
    },

    async applyService(stored, image, env, lease) {
      return await applyMachines(flyFor(stored.ns), stored, image, env, lease);
    },

    async observeService(stored) {
      const config = getConfig();
      const fly = flyFor(stored.ns);
      const appName = appNameForService(config.envId, stored.ns, stored.key);
      const [machines, certificates] = await Promise.all([fly.listMachines(appName), fly.listCertificates(appName)]);
      const startedCount = machines.filter((machine) => machine.state === "started").length;
      const machineRevisions = new Set(machines.map((machine) => machine.config.metadata?.hexclave_revision ?? "unknown"));
      const allAtTarget = machines.length > 0 && machineRevisions.size === 1 && machineRevisions.has(stored.revision);
      const runningRevision = machines.length === 0 ? null : machineRevisions.size === 1 ? [...machineRevisions][0] : [...machineRevisions].find((revision) => revision !== stored.revision) ?? stored.revision;
      const address = await serviceAddress(fly, stored.ns, stored.key, stored, certificates);
      return {
        ...address,
        exists: machines.length > 0,
        ready: startedCount >= pinnedMachineCount(stored.spec),
        instances: startedCount,
        revision: runningRevision,
        atTarget: allAtTarget && machines.length === desiredMachineCount(stored.spec),
        error: null,
      };
    },

    async deleteService(_stored, ns, key, lease) {
      const config = getConfig();
      const fly = flyFor(ns);
      const appName = appNameForService(config.envId, ns, key);
      // Destroying a Fly app destroys its VOLUMES with it (smoke-verified against real Fly),
      // so a volume-backed service is torn down by DETACHING instead: kill the machines and
      // the public ingress, and leave the app holding its disks. That is what makes removing
      // a service from a deploy file survivable — the contract is that the volume outlives
      // the service and needs an explicit delete — and re-syncing the same service id adopts
      // the disk again by name (ensureVolume selects it deterministically).
      //
      // Only a service with no volumes takes the destroy path, where nothing is lost and
      // leaving an empty app behind would burn the org's app-count limit instead.
      const volumes = await fly.listVolumes(appName);
      if (volumes.length > 0) {
        for (const machine of await fly.listMachines(appName)) {
          await lease.assertOwned();
          await fly.destroyMachine(appName, machine.id);
        }
        // Nothing serves this app any more, so its public IPs must go: the certificates
        // were released by domains.releaseForService, which is what lets this release
        // rather than no-op.
        await lease.assertOwned();
        await reconcilePublicIps(fly, appName, "private");
      } else {
        // force=true kills machines and releases IPs in one call.
        await lease.assertOwned();
        await fly.deleteApp(appName);
      }
    },

    async address(ns, key, stored) {
      return await serviceAddress(flyFor(ns), ns, key, stored);
    },

    hostnamePlaceholder(ns, key) {
      return hostnameForService(getConfig().envId, ns, key);
    },

    staticPrivateHost(ns, key) {
      return hostnameForService(getConfig().envId, ns, key);
    },

    async serviceLogs(stored, sinceMillis, instance) {
      const page = await fetchLogPage(flyFor(stored.ns), appNameForService(getConfig().envId, stored.ns, stored.key), { sinceMillis, instance });
      return { lines: page.lines, nextSinceMillis: page.nextSinceMillis };
    },

    async builderLogsLive(deployment, sinceMillis, redactionValues) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) {
        return { lines: [], nextSinceMillis: sinceMillis ?? deployment.started_at_millis };
      }
      const page = await fetchLogPage(flyFor(deployment.ns), deployment.builder_app, {
        sinceMillis: sinceMillis ?? deployment.started_at_millis,
        instance: deployment.builder_machine_id,
        forceNullInstance: true,
      });
      return {
        lines: page.lines.map((line) => ({ ...line, text: redactBuildLogText(line.text, redactionValues) })),
        nextSinceMillis: page.nextSinceMillis,
      };
    },

    async builderLogsDrain(deployment, redactionValues) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) return [];
      const lines = await fetchAllLogs(flyFor(deployment.ns), deployment.builder_app, {
        sinceMillis: deployment.started_at_millis - 60 * 1000,
        instance: deployment.builder_machine_id,
      });
      return lines.map((line) => ({ ...line, text: redactBuildLogText(line.text, redactionValues) }));
    },

    async builderLiveness(deployment) {
      if (deployment.builder_app === null || deployment.builder_machine_id === null) return { alive: false, startupFailed: false, tail: "" };
      let machine;
      try {
        machine = await flyFor(deployment.ns).getMachine(deployment.builder_app, deployment.builder_machine_id);
      } catch (error) {
        // A transient Fly error here must not turn a read into a 502 — leave the
        // deployment as-is until the next read.
        console.error(`stale-build liveness check for ${deployment.ns}/${deployment.id} failed`, error);
        return null;
      }
      // Still running: the watchdog has not fired yet (a clock skew, a long machine start).
      const alive = machine !== null && (machine.state === "started" || machine.state === "created" || machine.state === "starting");
      return { alive, startupFailed: false, tail: "" };
    },

    async deleteBuilder() {
      // The builder machine is created with auto_destroy: Fly reclaims it when the harness
      // exits, and its logs survive the destruction.
    },

    buildRedactionValues() {
      // The org token (with and without its "FlyV1 " scheme) and the registry basic-auth blob,
      // both of which the builder machine holds in its env.
      const { token } = flyConfig();
      const values = [token, Buffer.from(`x:${token}`).toString("base64")];
      if (token.startsWith("FlyV1 ")) values.push(token.slice("FlyV1 ".length));
      return values;
    },

    domains: {
      attach: attachDomain,
      read: readDomain,
      detach: detachDomain,
      async statesFor(ns, key) {
        const fly = flyFor(ns);
        const appName = appNameForService(getConfig().envId, ns, key);
        const certificates = await fly.listCertificates(appName);
        return await computeDomainStates(fly, appName, certificates);
      },
      async releaseForService(ns, key, _stored, lease) {
        const fly = flyFor(ns);
        const appName = appNameForService(getConfig().envId, ns, key);
        // Release hostname claims first — the bucket registry would otherwise block the
        // hostname forever. The certificate goes with it: on the destroy path certs die with
        // the app anyway, and on the detach path the app outlives the service, so a cert left
        // behind would keep a hostname pointing at a machine-less app that nothing can serve
        // — and would make Fly refuse the same hostname when it is re-attached elsewhere.
        for (const hostname of await listDomainClaimsForService(ns, key)) {
          const claim = await readDomainClaimVersioned(hostname);
          if (claim !== null && claim.value.ns === ns && claim.value.service_key === key) {
            await lease.assertOwned();
            await fly.deleteCertificate(appName, hostname);
            await releaseDomainClaim(claim);
          }
        }
      },
    },
  };
  return provider;
}
