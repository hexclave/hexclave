// Core logic for the Deployments app: service definitions (synced from a deploy
// file's `services` export into DeploymentService rows) + operational state
// (Prisma) + the write-through to Marshal, the Google Cloud-backed container runtime
// (apps/marshal).
//
// The shape of the world, because it is easy to mix up:
//
// - A DEPLOYMENT SOURCE is one deploy file: hexclave.deploy.ts, named by its own
//   `id` export (or hexclave.config.ts, whose services belong to a source named
//   after the file). It is the unit one `hexclave deploy` ships — one upload,
//   one build — which is what lets several repositories deploy into one project
//   without touching each other's services.
// - A "service id" is the user-facing key of the record returned by that file's
//   `services` export (e.g. "api"). It is unique across the PROJECT, not per
//   source, so a connection reference never has to name a source; two sources
//   declaring the same id is a conflict, refused at sync. It doubles as the
//   Marshal service key.
// - The Marshal "namespace" is the tenancy id: every runtime resource of a
//   tenancy lives behind one namespace, and Marshal keeps namespaces
//   network-isolated from each other.
// - A DEPLOYMENT is one `hexclave deploy` of one source. It owns the build (one
//   builder machine builds every service of the source), the build's log, the
//   redaction snapshot for that log, and the per-service outcomes. There is no
//   per-service run entity: with one build per deploy there would be nothing in
//   it that an outcome does not already say.
//
// Two things deliberately OUTLIVE the service that uses them, because the
// resource behind them does: a persistent VOLUME (a disk with tenant data) is
// owned by the deployment source and merely mounted by a service, and a custom
// DOMAIN (a hostname with a certificate) is owned by the project and merely
// pointed at one. Dropping a service from a deploy file tears the service down
// and leaves both behind, unattached, until someone deletes them explicitly.
//
// Secret VALUES are never part of a definition; they live in the project secret
// store (see @/lib/project-secrets), envelope-encrypted via KMS. Neither are
// secret DEFAULTS (`secret(key, default)`): they travel with the deploy request
// and are never persisted, so the dashboard's secrets page can present a single
// unambiguous state — a key either has a stored value or it isn't there.

import { getPlanIdForProjectOrNull } from "@/lib/plan-entitlements";
import { Tenancy } from "@/lib/tenancies";
import { PrismaClientTransaction, globalPrismaClient } from "@/prisma-client";
import type { DeploymentStatus, Prisma } from "@/generated/prisma/client";
import { readProjectSecretValue } from "@/lib/project-secrets";
import {
  DEPLOYMENT_CONNECTION_VALUE_REGEX,
  DEPLOYMENT_ENV_VAR_KEY_REGEX,
  DeploymentEnvVarDefinition,
  DeploymentPortEntry,
  DeploymentPorts,
  DeploymentServiceDefinition,
  DeploymentServiceType,
  DeploymentSourceManifest,
  HEXCLAVE_OUTPUT_KEYS,
  HEXCLAVE_SERVICE_ID,
  SERVICE_OUTPUT_KEYS,
  deploymentPortEntries,
  deploymentPortEntry,
  formatConnectionValue,
  parseConnectionValue,
  parseSourceManifest,
  soleHttpDeploymentPort,
  standardPortsHolderPort,
} from "@hexclave/shared/dist/deployments";
import { decryptWithKms, encryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { PROJECT_SECRET_KEY_REGEX } from "@hexclave/shared/dist/project-secrets";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { MarshalApiError, MarshalClient, MarshalDeployment, MarshalDeploymentTarget, MarshalDnsRecord, MarshalEnvValue, getMarshalClientOrThrow, getMarshalDeploymentsConfigOrNull, sanitizeMarshalError } from "./marshal-client";

export { HEXCLAVE_SERVICE_ID };

export const ENV_VAR_KEY_REGEX = DEPLOYMENT_ENV_VAR_KEY_REGEX;

// Default scaling bounds when the definition leaves them out. A "server" holds
// one instance and defaults to keeping it up; a "serverless" defaults to scaling
// to zero with a single instance at the top.
export const DEFAULT_SERVER_MIN_INSTANCES = 1;
export const DEFAULT_MIN_INSTANCES = 0;
export const DEFAULT_MAX_INSTANCES = 1;

export type DeploymentServiceRow = Prisma.DeploymentServiceGetPayload<{ include: { source: true } }>;

/** The Marshal namespace of a tenancy. One place so it cannot drift. */
export function marshalNamespaceForTenancy(tenancy: Tenancy): string {
  return tenancy.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a DeploymentService row's stored `ports` JSON — an object keyed by port
 * number, the same shape the deploy file writes. Like `env`, the column is only
 * ever written through the sync route (validated against
 * deploymentServiceDefinitionSchema), so a malformed TOP-LEVEL shape is an
 * assertion failure. An EMPTY object is legitimate: it is both a portless worker
 * and what a row that predates a synced definition holds.
 */
function parseStoredPorts(ports: Prisma.JsonValue, serviceId: string): DeploymentPorts {
  // Prisma types the column as never-undefined, but a partial `select` that
  // omits it hands this function undefined at run time.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (ports === null || ports === undefined) return {};
  if (!isRecord(ports)) {
    throw new HexclaveAssertionError(`Stored ports of deployment service ${JSON.stringify(serviceId)} is not an object`, { ports });
  }
  const parsed: DeploymentPorts = {};
  for (const [portKey, definition] of Object.entries(ports)) {
    if (!isRecord(definition)) {
      throw new HexclaveAssertionError(`Stored port ${portKey} of deployment service ${JSON.stringify(serviceId)} is not an object`, { ports });
    }
    const protocol = definition.protocol;
    if (protocol !== "http" && protocol !== "tcp") {
      throw new HexclaveAssertionError(`Stored port ${portKey} of deployment service ${JSON.stringify(serviceId)} is missing a valid protocol`, { ports });
    }
    parsed[portKey] = { protocol };
  }
  return parsed;
}

/**
 * Parses a DeploymentService row's stored `env` JSON. The column is only ever
 * written through the sync route (which validates against
 * deploymentServiceDefinitionSchema), so a malformed TOP-LEVEL shape is an
 * assertion failure — but individual entries are still normalized leniently at
 * their use sites (see normalizeEnvVarConfig) so one bad entry can't take
 * down a whole listing.
 */
function parseStoredEnv(env: Prisma.JsonValue, serviceId: string): Record<string, DeploymentEnvVarDefinition> {
  // Writes use entry arrays because Prisma's JSON serializer drops special object keys such as
  // `__proto__`. The object representation stays readable so a hand-written row still loads.
  const entries: [string, Prisma.JsonValue][] = [];
  if (Array.isArray(env)) {
    for (const tuple of env) {
      if (!Array.isArray(tuple) || tuple.length !== 2) {
        throw new HexclaveAssertionError(`Stored env entry of deployment service ${JSON.stringify(serviceId)} is not a key-value pair`, { env });
      }
      const [envVarKey, entry] = tuple;
      if (typeof envVarKey !== "string") {
        throw new HexclaveAssertionError(`Stored env entry of deployment service ${JSON.stringify(serviceId)} has an invalid key or value`, { env });
      }
      entries.push([envVarKey, entry]);
    }
  } else if (isRecord(env)) {
    for (const [envVarKey, entry] of Object.entries(env)) {
      if (entry === undefined) {
        throw new HexclaveAssertionError(`Stored env entry ${JSON.stringify(envVarKey)} of deployment service ${JSON.stringify(serviceId)} is undefined`, { env });
      }
      entries.push([envVarKey, entry]);
    }
  } else {
    throw new HexclaveAssertionError(`Stored env of deployment service ${JSON.stringify(serviceId)} is neither an entry array nor a record`, { env });
  }
  const result = new Map<string, DeploymentEnvVarDefinition>();
  for (const [envVarKey, entry] of entries) {
    if (!isRecord(entry)) {
      captureError("deployments-stored-env-entry-invalid", new HexclaveAssertionError(`Skipping non-object stored env entry ${JSON.stringify(envVarKey)} of service ${JSON.stringify(serviceId)}`));
      continue;
    }
    result.set(envVarKey, {
      // Unknown type STRINGS are passed through on purpose (hence the cast:
      // the type system can't express "the union, or an unknown string to be
      // rejected later" without widening every consumer). Erasing them here
      // would silently downgrade the entry to a plain var — while
      // normalizeEnvVarConfig's default branch exists precisely to fail loud
      // on them (hand-edited rows, version skew after a rollback).
      type: typeof entry.type === "string" ? entry.type as DeploymentEnvVarDefinition["type"] : undefined,
      value: typeof entry.value === "string" ? entry.value : undefined,
      key: typeof entry.key === "string" ? entry.key : undefined,
    });
  }
  return Object.fromEntries(result);
}

/**
 * The definition as stored, plus the volume the service currently mounts (which
 * lives on a row of its own, because the disk outlives the service).
 */
export function definitionFromServiceRow(row: {
  serviceId: string,
  type: string,
  isPublic: boolean,
  ports: Prisma.JsonValue,
  minInstances: number | null,
  maxInstances: number | null,
  rootDirectory: string | null,
  dockerfilePath: string | null,
  image: string | null,
  buildCommand: string | null,
  startCommand: string | null,
  env: Prisma.JsonValue,
}, volume: { volumeId: string, path: string | null, sizeGb: number } | null = null): DeploymentServiceDefinition {
  if (row.type !== "server" && row.type !== "serverless") {
    throw new HexclaveAssertionError(`Deployment service ${JSON.stringify(row.serviceId)} has invalid type ${JSON.stringify(row.type)}.`);
  }
  return {
    type: row.type,
    public: row.isPublic,
    // Rows that predate a synced definition have no ports. Callers that build a
    // runtime spec must reject that before it reaches Marshal (the deploy route
    // guards it) — an empty record is not a deployable service, only a
    // displayable one.
    ports: parseStoredPorts(row.ports, row.serviceId),
    min_instances: row.minInstances ?? undefined,
    max_instances: row.maxInstances ?? undefined,
    root_directory: row.rootDirectory ?? undefined,
    dockerfile_path: row.dockerfilePath ?? undefined,
    image: row.image ?? undefined,
    build_command: row.buildCommand ?? undefined,
    start_command: row.startCommand ?? undefined,
    // A volume row with no mount path is unattached — it belongs to the source
    // rather than to this service, so it is not part of the definition.
    persistent_volumes: volume !== null && volume.path !== null
      ? { [volume.volumeId]: { path: volume.path, size_gb: volume.sizeGb } }
      : undefined,
    env: parseStoredEnv(row.env, row.serviceId),
  };
}

// ---------------------------------------------------------------------------
// Deployment sources

export async function getOrCreateDeploymentSource(prisma: PrismaClientTransaction, tenancy: Tenancy, sourceId: string): Promise<{ id: string, sourceId: string }> {
  return await prisma.deploymentSource.upsert({
    where: { tenancyId_sourceId: { tenancyId: tenancy.id, sourceId } },
    update: {},
    create: { tenancyId: tenancy.id, sourceId },
    select: { id: true, sourceId: true },
  });
}

export async function listServiceRows(prisma: PrismaClientTransaction, tenancy: Tenancy, options?: { sourceRowId?: string }): Promise<DeploymentServiceRow[]> {
  return await prisma.deploymentService.findMany({
    where: { tenancyId: tenancy.id, ...(options?.sourceRowId !== undefined ? { sourceRowId: options.sourceRowId } : {}) },
    include: { source: true },
    orderBy: { serviceId: "asc" },
  });
}

export async function getServiceRowOrThrow(prisma: PrismaClientTransaction, tenancy: Tenancy, serviceId: string): Promise<DeploymentServiceRow> {
  const row = await prisma.deploymentService.findUnique({
    where: { tenancyId_serviceId: { tenancyId: tenancy.id, serviceId } },
    include: { source: true },
  });
  if (row == null) {
    throw new StatusError(404, `No deployment service with id ${JSON.stringify(serviceId)} exists in this project. Add it to the \`services\` of your hexclave.deploy.ts and run \`hexclave deploy\`.`);
  }
  return row;
}

/** The volume a service currently mounts, if any. */
export async function getServiceVolume(prisma: PrismaClientTransaction, tenancy: Tenancy, serviceId: string) {
  return await prisma.deploymentVolume.findUnique({
    where: { tenancyId_serviceId: { tenancyId: tenancy.id, serviceId } },
  });
}

/**
 * The Free plan's deployment entitlements. Two rules, one plan read.
 *
 * A `server` is paid-only, whatever its `minInstances`. A server is a VM that
 * runs from the moment it is applied until the service is torn down: GCP offers
 * no idle-suspend and no wake-on-request (Compute Engine's suspend is a manual
 * API call, unavailable on the E2 machine types and COS images these VMs use),
 * so `minInstances: 0` on a server does not scale it to zero. It is accepted
 * and ignored — `applyRuntimeService` never passes it to Compute Engine.
 * Gating on `minInstances` alone therefore let a Free project hold a machine up
 * around the clock by writing the one value that reads like opting out of
 * exactly that, which is why the type is now gated on its own.
 *
 * A `serverless` may still choose its floor, and `minInstances` above 0 is
 * paid: it keeps a Cloud Run instance warm between requests. Cloud Run really
 * does scale to zero, so there `minInstances: 0` means what it says and stays
 * free.
 *
 * Called from BOTH doors, and it has to be:
 *
 *   - The definition sync is the first server call `hexclave deploy` makes, so
 *     checking there fails before any source is packaged or uploaded and puts
 *     the message at the top of the deploy output. That is UX, not a boundary:
 *     the sync is skippable by anyone calling the API directly.
 *   - The deploy is the actual entitlement boundary. It accepts any stored
 *     definition whose `definition_sync_id` still matches, so without a recheck
 *     a team could sync while paid, downgrade, and keep deploying always-on
 *     machines with the old sync id.
 *
 * `persistentVolumes` is deliberately NOT gated: disks are available on every
 * plan for now. That is a pricing decision, not an oversight. In practice only
 * a `server` may hold one, so the type gate above already reserves them.
 *
 * FUTURE: this gates new DEPLOYS, not machines already running. A team can
 * subscribe, deploy always-on services, cancel, and keep those machines
 * indefinitely, since they never need to re-deploy. Closing that needs a
 * downgrade-time sweep that rescales running services, which belongs with the
 * billing lifecycle rather than here.
 */
export async function assertServicesAllowedByPlan(tenancy: Tenancy, services: Record<string, DeploymentServiceDefinition>): Promise<void> {
  const entries = Object.entries(services);
  // A server is refused on its type alone, so it is deliberately excluded from
  // the always-on list below: the two problems have different remedies, and a
  // service named under both would be told to fix it twice.
  const serverServices = entries
    .filter(([, definition]) => definition.type === "server")
    .map(([serviceId]) => serviceId)
    .sort(stringCompare);
  const alwaysOnServices = entries
    .filter(([, definition]) => definition.type !== "server" && effectiveMinInstances(definition) > 0)
    .map(([serviceId]) => serviceId)
    .sort(stringCompare);
  if (serverServices.length === 0 && alwaysOnServices.length === 0) return;

  // Null = this project isn't plan-gated at all (self-hosted, or plan limits
  // disabled) or the plan couldn't be read. All of those must fail open —
  // deploying can't depend on the billing store being reachable.
  if (await getPlanIdForProjectOrNull(tenancy.project) !== "free") return;

  // Both sections can fire at once, and the CLI truncates the whole message at
  // 1000 chars — so name fewer services when there are two remedies to fit.
  const cap = serverServices.length > 0 && alwaysOnServices.length > 0 ? 3 : 5;
  const lines: string[] = [];
  if (serverServices.length > 0) {
    lines.push(
      `\`server\` services are not available on the Free plan, but ${serverServices.length === 1 ? `service ${planGateServiceList(serverServices, cap)} is` : `services ${planGateServiceList(serverServices, cap)} are`} declared as one.`,
      "",
      "A `server` holds a machine and its disk from deploy until you tear it down — `minInstances: 0` does not make it scale to zero. Either:",
      "  - use `type: \"serverless\"`, which scales to zero and cold-starts on the next request (it can have no persistent volume); or",
      "  - upgrade your plan at https://app.hexclave.com to run persistent servers.",
    );
  }
  if (alwaysOnServices.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Always-on instances are not available on the Free plan, but ${alwaysOnServices.length === 1 ? `service ${planGateServiceList(alwaysOnServices, cap)} keeps` : `services ${planGateServiceList(alwaysOnServices, cap)} keep`} an instance running (\`minInstances\` above 0).`,
      "",
      "Either:",
      `  - set \`minInstances: 0\` on ${alwaysOnServices.length === 1 ? "that service" : "those services"}, which scales to zero and cold-starts on the next request; or`,
      "  - upgrade your plan at https://app.hexclave.com to keep instances always on.",
    );
  }
  throw new StatusError(400, lines.join("\n"));
}

/**
 * Names the offending services for a plan-gate message.
 *
 * The CLI truncates the surfaced message at 1000 chars and the remedy comes
 * last, so cap the list rather than let a config with many long service ids
 * push the actionable half off the end.
 */
function planGateServiceList(serviceIds: string[], cap: number): string {
  const shown = serviceIds.slice(0, cap).map((serviceId) => `\`${serviceId}\``);
  return serviceIds.length > shown.length
    ? `${shown.join(", ")}, and ${serviceIds.length - shown.length} more`
    : shown.join(", ");
}

/**
 * The platform-wide ceiling on live services, and so on Fly apps: every
 * provisioned service holds one.
 *
 * This is Hexclave's own capacity guard, not a per-project quota. Fly org limits
 * (app count, IP allocations, API rate) are shared by every project on this
 * instance, and hitting them does not fail politely — it fails somewhere in the
 * middle of a rollout, for whoever happens to deploy next. Refusing at the door
 * instead means the operator finds out from Sentry rather than from a stream of
 * half-deployed tenants.
 *
 * Overridable because a self-hosted instance runs against its own Fly org, where
 * this number is somebody else's to choose.
 */
export const MAX_GLOBAL_DEPLOYED_SERVICES = Number(getEnvVariable("HEXCLAVE_MAX_DEPLOYED_SERVICES", "1000"));

/**
 * Refuses a deploy that would take this Hexclave instance past its Fly capacity,
 * and tells the operator about it.
 *
 * Counts SERVICES rather than deployments: a deployment is a point in time,
 * while each provisioned service is a Fly app that goes on existing. Only
 * services this deploy would newly provision count against the ceiling — a
 * re-deploy of something already running consumes no additional app.
 *
 * The count is over the whole database, across every tenancy, which is what
 * makes it a platform guard rather than a per-project one.
 */
export async function assertGlobalDeploymentCapacity(tenancy: Tenancy, newlyProvisioningServiceCount: number): Promise<void> {
  if (newlyProvisioningServiceCount <= 0) return;
  // A non-numeric override would otherwise disable the guard silently, which is
  // the one failure mode a capacity guard must not have.
  if (!Number.isFinite(MAX_GLOBAL_DEPLOYED_SERVICES) || MAX_GLOBAL_DEPLOYED_SERVICES <= 0) {
    captureError("deployments-global-capacity-misconfigured", new HexclaveAssertionError(`HEXCLAVE_MAX_DEPLOYED_SERVICES is not a positive number (got ${JSON.stringify(getEnvVariable("HEXCLAVE_MAX_DEPLOYED_SERVICES", "1000"))}); refusing to deploy rather than deploying without a capacity guard.`));
    throw new StatusError(503, "Deployments are temporarily unavailable on this Hexclave instance because its capacity limit is misconfigured. This has been reported; please try again later.");
  }
  const provisionedServiceCount = await globalPrismaClient.deploymentService.count({
    where: { provisionedAt: { not: null } },
  });
  if (provisionedServiceCount + newlyProvisioningServiceCount <= MAX_GLOBAL_DEPLOYED_SERVICES) return;

  // Reported as an ERROR rather than a warning: nobody can deploy a new service
  // until an operator acts, so this is a page-worthy state for the platform even
  // though the individual request failed cleanly.
  captureError("deployments-global-capacity-exhausted", new HexclaveAssertionError(
    `Hexclave is at its global deployment capacity: ${provisionedServiceCount} of ${MAX_GLOBAL_DEPLOYED_SERVICES} services are provisioned, and a deploy asked for ${newlyProvisioningServiceCount} more. New services cannot be deployed until capacity is raised (HEXCLAVE_MAX_DEPLOYED_SERVICES) or unused ones are torn down.`,
    { projectId: tenancy.project.id, provisionedServiceCount, requested: newlyProvisioningServiceCount, limit: MAX_GLOBAL_DEPLOYED_SERVICES },
  ));
  throw new StatusError(503, [
    "Hexclave has reached its limit on the number of deployed services and cannot create new ones right now.",
    "",
    // Says what the user CAN do — re-deploying what they already run still
    // works, since it provisions nothing new.
    "This is a platform-wide limit, not a limit on your project, and it has been reported to the Hexclave team automatically. Deploys of services you are already running are unaffected; please try again later, or contact support if this is blocking you.",
  ].join("\n"));
}

/**
 * The instance floor a definition actually deploys with, applying the per-type
 * default. A "server" defaults to 1 (stay up) — which is exactly why the plan
 * gate has to read the EFFECTIVE value rather than the written one.
 */
export function effectiveMinInstances(definition: DeploymentServiceDefinition): number {
  if (definition.type === "server") return definition.min_instances ?? DEFAULT_SERVER_MIN_INSTANCES;
  return definition.min_instances ?? DEFAULT_MIN_INSTANCES;
}

/**
 * A service may declare at most one persistent volume (a Fly machine mounts at
 * most one), so every caller wants the single entry rather than the record.
 */
export function singleVolume(definition: DeploymentServiceDefinition): { volumeId: string, path: string, sizeGb: number } | null {
  const entries = Object.entries(definition.persistent_volumes ?? {});
  if (entries.length === 0) return null;
  return { volumeId: entries[0][0], path: entries[0][1].path, sizeGb: entries[0][1].size_gb };
}

/**
 * Rejects a sync that would shrink a volume, BEFORE anything is packaged or
 * uploaded.
 *
 * Volumes are grow-only (Fly refuses a shrink, and shrinking would destroy
 * tenant data). Marshal enforces that too, but only at apply time — by then
 * `hexclave deploy` has already built the tarball and consumed an upload slot,
 * so the author gets the error at the worst possible moment. The previously
 * synced size is right here in the row, so catch it at the door.
 *
 * Marshal's check stays as the backstop: this column can drift from the disk's
 * real size (a sync that succeeded followed by an apply that never converged),
 * and only the runtime knows what Fly actually has.
 */
async function assertNoVolumeShrink(prisma: PrismaClientTransaction, tenancy: Tenancy, sourceRowId: string, services: Record<string, DeploymentServiceDefinition>): Promise<void> {
  const existing = await prisma.deploymentVolume.findMany({
    where: { tenancyId: tenancy.id, sourceRowId },
    select: { volumeId: true, sizeGb: true },
  });
  const sizeByVolumeId = new Map(existing.map((row) => [row.volumeId, row.sizeGb]));
  for (const [serviceId, definition] of Object.entries(services)) {
    const next = singleVolume(definition);
    if (next === null) continue;
    // Compared per DISK, not per service: the disk is owned by the deployment
    // source, so moving it to another service is not a resize of anything.
    const previousSize = sizeByVolumeId.get(next.volumeId);
    if (previousSize === undefined || next.sizeGb >= previousSize) continue;
    throw new StatusError(400, [
      `The volume \`${next.volumeId}\` (mounted by service \`${serviceId}\`) is already ${previousSize}GB and cannot be shrunk to ${next.sizeGb}GB — disks can only grow.`,
      "",
      // Deliberately does NOT suggest detaching and re-adding smaller: the Fly
      // volume outlives the detach, so that path would slip past this check and
      // fail at apply time instead — after the upload has been consumed.
      `Set its \`sizeGb\` back to at least ${previousSize}. To start over at a smaller size, give it a new volume id — the existing disk is a separate one and keeps its data.`,
    ].join("\n"));
  }
}

/** Rejects two services of one sync claiming the same volume id. */
function assertNoVolumeIdConflicts(services: Record<string, DeploymentServiceDefinition>): void {
  const claimedBy = new Map<string, string>();
  for (const [serviceId, definition] of Object.entries(services)) {
    const volume = singleVolume(definition);
    if (volume === null) continue;
    const existing = claimedBy.get(volume.volumeId);
    if (existing !== undefined) {
      throw new StatusError(400, `Services \`${existing}\` and \`${serviceId}\` both declare the persistent volume \`${volume.volumeId}\`. A volume is one disk and can only be mounted by one service — give one of them a different id.`);
    }
    claimedBy.set(volume.volumeId, serviceId);
  }
}

export type SyncSourceServicesResult = {
  // Services this source used to declare and no longer does. Their rows are
  // gone; the caller tears the runtime side down (see tearDownServices).
  removedServiceIds: string[],
};

/**
 * Upserts the definitions of ONE deployment source, and removes the services it
 * no longer declares.
 *
 * The source is what makes removal safe to do at all: a deploy file is the whole
 * truth about its own services, and says nothing about anybody else's. Rows
 * belonging to other sources are never touched here, which is what lets several
 * repositories deploy into one project.
 */
export async function syncSourceServices(
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  source: { id: string, sourceId: string },
  services: Record<string, DeploymentServiceDefinition>,
  definitionSyncId: string,
): Promise<SyncSourceServicesResult> {
  await assertNoVolumeShrink(prisma, tenancy, source.id, services);
  assertNoVolumeIdConflicts(services);

  // Service ids are unique across the PROJECT, so a sync that claims one owned
  // by another source is refused rather than silently taking it over — the two
  // deploy files would otherwise overwrite each other's definition on every
  // deploy, and the loser's author would have no way to see why.
  const conflicting = await prisma.deploymentService.findMany({
    where: { tenancyId: tenancy.id, serviceId: { in: Object.keys(services) }, sourceRowId: { not: source.id } },
    include: { source: { select: { sourceId: true } } },
  });
  if (conflicting.length > 0) {
    const [first] = conflicting;
    throw new StatusError(409, [
      `The service id \`${first.serviceId}\` is already deployed by the deployment source \`${first.source.sourceId}\`${conflicting.length > 1 ? ` (and ${conflicting.length - 1} more of this deploy's services are too)` : ""}.`,
      "",
      "Service ids are unique across a project, so that a connection like `service(\"api\")` means one thing everywhere. Rename this service, or remove it from the other deploy file first.",
    ].join("\n"));
  }

  // A custom domain makes a service publicly reachable exactly the way a public
  // port does, so a service that HOLDS one has to satisfy the same port rules.
  const domainHolders = await prisma.deploymentDomain.findMany({
    where: { tenancyId: tenancy.id, serviceId: { in: Object.keys(services) } },
    select: { serviceId: true, hostname: true },
  });
  for (const domain of domainHolders) {
    if (domain.serviceId === null) continue;
    const problem = domainPortProblem(services[domain.serviceId].ports, services[domain.serviceId].public === true);
    if (problem !== null) {
      throw new StatusError(400, `Service ${JSON.stringify(domain.serviceId)} has the custom domain ${domain.hostname}, so ${problem}. Remove the domain first, or fix the service's ports.`);
    }
  }

  const previousRows = await prisma.deploymentService.findMany({
    where: { tenancyId: tenancy.id, sourceRowId: source.id },
    select: { serviceId: true },
  });
  const removedServiceIds = previousRows
    .map((row) => row.serviceId)
    .filter((serviceId) => !Object.hasOwn(services, serviceId))
    .sort(stringCompare);

  for (const [serviceId, definition] of Object.entries(services)) {
    const definitionColumns = {
      sourceRowId: source.id,
      definitionSyncedAt: new Date(),
      definitionSyncId,
      type: definition.type,
      // Visibility is the SERVICE's own column, not something derivable from
      // `ports` — the ports record no longer records it at all.
      isPublic: definition.public === true,
      ports: definition.ports,
      minInstances: definition.min_instances ?? null,
      maxInstances: definition.max_instances ?? null,
      rootDirectory: definition.root_directory ?? null,
      dockerfilePath: definition.dockerfile_path ?? null,
      // With no buildCommand this is the image to run and the service is not
      // built at all; with one it is the base it is built on. The schema has
      // already refused a definition that also names a dockerfilePath.
      image: definition.image ?? null,
      // Null = the base decides the build / the image decides what starts.
      buildCommand: definition.build_command ?? null,
      startCommand: definition.start_command ?? null,
      // The yup-validated env may contain explicit `undefined` fields, which
      // aren't valid JSON values; filter each entry at this boundary. Spelled
      // out field-by-field so the result is a Prisma-storable entry array
      // without any type assertions. The entry-array representation also
      // preserves object-prototype names through Prisma's JSON serializer.
      env: Object.entries(definition.env).map(([envVarKey, entry]): [string, Record<string, string>] => {
        const stored: Record<string, string> = {};
        if (entry.type !== undefined) stored.type = entry.type;
        if (entry.value !== undefined) stored.value = entry.value;
        if (entry.key !== undefined) stored.key = entry.key;
        return [envVarKey, stored];
      }),
    };
    await prisma.deploymentService.upsert({
      where: { tenancyId_serviceId: { tenancyId: tenancy.id, serviceId } },
      update: definitionColumns,
      create: { tenancyId: tenancy.id, serviceId, ...definitionColumns },
    });
  }

  // Volumes, after the services exist. Detach FIRST: a disk moving from one
  // service to another within this source would otherwise hit the one-disk-
  // per-service unique index depending on which service happened to be written
  // first, failing a sync that is perfectly valid as a whole.
  await prisma.deploymentVolume.updateMany({
    where: { tenancyId: tenancy.id, sourceRowId: source.id },
    data: { serviceId: null, path: null },
  });
  for (const [serviceId, definition] of Object.entries(services)) {
    const volume = singleVolume(definition);
    if (volume === null) continue;
    await prisma.deploymentVolume.upsert({
      where: { tenancyId_sourceRowId_volumeId: { tenancyId: tenancy.id, sourceRowId: source.id, volumeId: volume.volumeId } },
      // Grow-only, enforced above: take the larger of the two so a stale row
      // can never shrink the record of a disk Fly has already grown.
      update: { serviceId, path: volume.path, sizeGb: { set: volume.sizeGb } },
      create: { tenancyId: tenancy.id, sourceRowId: source.id, volumeId: volume.volumeId, serviceId, path: volume.path, sizeGb: volume.sizeGb },
    });
  }

  if (removedServiceIds.length > 0) {
    // The rows go; the DISK and the DOMAIN do not. Both are unattached instead,
    // because destroying tenant data (or releasing a certificate) on a config
    // edit is not something a deploy should ever do implicitly.
    await prisma.deploymentDomain.updateMany({
      where: { tenancyId: tenancy.id, serviceId: { in: removedServiceIds } },
      data: { serviceId: null, port: null },
    });
    await prisma.deploymentService.deleteMany({
      where: { tenancyId: tenancy.id, sourceRowId: source.id, serviceId: { in: removedServiceIds } },
    });
  }

  return { removedServiceIds };
}

/**
 * Tears down services the deploy file no longer declares. Best-effort per
 * service: their rows are already gone, so a runtime hiccup must not fail the
 * sync that removed them — it would leave the caller unable to retry (the second
 * sync sees nothing to remove).
 */
export async function tearDownServices(tenancy: Tenancy, serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0 || getMarshalDeploymentsConfigOrNull() == null) return;
  const client = getMarshalClientOrThrow();
  const ns = marshalNamespaceForTenancy(tenancy);
  for (const serviceId of serviceIds) {
    try {
      await client.deleteService(ns, serviceId);
    } catch (error) {
      captureError("deployments-teardown-removed-service", error);
    }
  }
}

/**
 * Why a service's ports cannot hold a custom domain, or null when they can. The
 * message is a clause that reads after "so ..." / "because it ...".
 *
 * KEPT IN SYNC WITH assertServiceCanHoldADomain in apps/marshal/src/services.ts
 * (which apps/marshal/src/domains.ts calls on every attach).
 *
 * Attaching a domain allocates public IPs on the service's Fly app, so it makes
 * the service reachable exactly the way `public: true` does. Fly `services` are
 * the proxy's listener set for the whole app with no per-address scoping, so
 * every declared port answers on every IP the app holds: a PRIVATE service with
 * an HTTP port next to a 5432 passes the sync — nothing is public — and then
 * publishes the database the moment a domain is attached.
 *
 * STRICTER THAN THE SYNC RULE, deliberately. The sync accepts a wholly private
 * multi-port service — unreachable, so nothing leaks — and a domain is precisely
 * what makes it reachable. So the siblings that were harmless at sync time are
 * the leak here. The one port a private service may front with a domain is its
 * ONLY port: publishing it is what the domain was asked for. A PUBLIC service is
 * fine at any port count; it is already reachable, and the domain simply fronts
 * the standard-ports holder (its lowest port, the one that owns 80/443) while
 * the rest keep answering on their own numbers.
 *
 * The HTTP requirement is separate: a domain terminates TLS and routes HTTP, so
 * a service declaring only TCP ports (or none at all — a portless worker) has
 * nothing to route to.
 */
export function domainPortProblem(ports: DeploymentPorts, isPublic: boolean): string | null {
  const entries = deploymentPortEntries(ports);
  if (!entries.some((entry) => entry.protocol === "http")) {
    return entries.length === 0
      ? 'it must declare a port with protocol: "http" to route to (it declares none)'
      : 'it must declare a port with protocol: "http" to route to (it declares only TCP ports)';
  }
  if (!isPublic && entries.length > 1) {
    return `it is private and declares more than one port (${entries.length}): a domain allocates public IPs, and the runtime's proxy serves every declared port on every address the app has, so the others would be published too. Make the service public: true, or move them onto their own service and reach them with hostname()`;
  }
  if (domainPortForService(ports, isPublic) === null) {
    return `it leaves ambiguous which port the domain would front (it declares ${entries.length}): a certificate terminates TLS on one port only`;
  }
  return null;
}

// Bare hostname (no scheme/path/port), at least two labels. Shared by every
// path that accepts a hostname so validation can't drift between them again.
//
// KEPT IN SYNC WITH apps/marshal/src/domains.ts, which duplicates it because
// Marshal is a standalone service with no @hexclave/shared dependency. This copy
// must stay AT LEAST AS STRICT as Marshal's: a hostname the backend accepts and
// Marshal later rejects is stored as a domain row that can never be attached and
// never verifies, and the runtime's rejection is deliberately swallowed at deploy
// time — so it sits permanently pending with nothing reporting why.
export const HOSTNAME_REGEX = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Lowercases and validates a user-supplied hostname, or throws a clean 400. */
export function normalizeHostnameOrThrow(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (!HOSTNAME_REGEX.test(normalized)) {
    throw new StatusError(400, `Invalid domain hostname ${JSON.stringify(hostname)} — must be a bare hostname like app.example.com, not a URL.`);
  }
  return normalized;
}

/**
 * The port a domain fronts on its service: the one that owns 80/443, since a
 * certificate terminates TLS there and nowhere else.
 *
 * For a private service that is its sole HTTP port (the domain is what publishes
 * it). For a PUBLIC service it is the standard-ports holder — its lowest port —
 * and the others keep answering on their own numbers,
 * unfronted by the hostname. Null when neither is determinate, which
 * domainPortProblem reports before any caller reaches this.
 */
export function domainPortForService(ports: DeploymentPorts, isPublic: boolean): number | null {
  return standardPortsHolderPort(ports, isPublic);
}

// ---------------------------------------------------------------------------
// Env vars

// A definition env var narrowed into its three valid shapes. The stored
// definition type leaves `type`/`value`/`key` independently optional, so this
// is the boundary where the coupling rules become explicit.
export type NormalizedDeploymentEnvVar =
  | { type: "plain", value: string }
  | { type: "secret", secretKey: string }
  // `port` is the optional `:<port>` suffix of a `url` reference, naming which
  // port the URL means on a multi-port service.
  | { type: "connection", serviceId: string, outputKey: string, port: number | null };

/**
 * Narrows a definition env var into one of the three valid shapes, or throws a
 * clean 400. Invalid combinations are rejected by the sync route's schema, but
 * this stays a user-facing error rather than an assertion so a legacy or
 * hand-edited row surfaces as a per-entry problem instead of a 500.
 */
export function normalizeEnvVarConfig(envVarKey: string, config: DeploymentEnvVarDefinition): NormalizedDeploymentEnvVar {
  switch (config.type) {
    case "secret": {
      if (config.key == null || !PROJECT_SECRET_KEY_REGEX.test(config.key)) {
        throw new StatusError(400, `The env var ${JSON.stringify(envVarKey)} has type "secret" but no valid secret key (letters, numbers, underscores, and hyphens).`);
      }
      return { type: "secret", secretKey: config.key };
    }
    case "connection": {
      if (config.value == null || !DEPLOYMENT_CONNECTION_VALUE_REGEX.test(config.value)) {
        throw new StatusError(400, `The env var ${JSON.stringify(envVarKey)} has type "connection" but its value is not a service output reference like "hexclave.projectId".`);
      }
      const parsed = parseConnectionValue(config.value) ?? throwErr(`The env var ${JSON.stringify(envVarKey)} passed the connection regex but could not be parsed.`);
      return { type: "connection", serviceId: parsed.serviceId, outputKey: parsed.outputKey, port: parsed.port };
    }
    case undefined: {
      if (config.value == null) {
        throw new StatusError(400, `The env var ${JSON.stringify(envVarKey)} has no value. Add a \`value\`, or give it a type ("secret" or "connection").`);
      }
      return { type: "plain", value: config.value };
    }
    default: {
      // TS considers the switch exhaustive, but the value comes from stored
      // JSON — a write path that skips validation (or a direct DB edit) could
      // store any string, and returning undefined here would crash callers
      // with a TypeError instead of a clean per-entry error.
      throw new StatusError(400, `The env var ${JSON.stringify(envVarKey)} has an unknown type ${JSON.stringify(config.type)}. Supported: "secret", "connection", or no type for a plain value.`);
    }
  }
}

/**
 * The Hexclave credentials every deployed service gets without asking, and the
 * framework-prefixed copies of the public ones.
 *
 * The prefixes exist because a framework that INLINES values at build time
 * (Next's NEXT_PUBLIC_*, Vite's VITE_*) only reads its own; an unprefixed
 * variable is invisible to the client bundle no matter what the build does. A
 * service that wants a different name still writes it in `env` — an explicit
 * entry always wins over these.
 *
 * The secret server key gets NO prefixed copies: a prefixed name is a request to
 * publish the value to the browser, which for a server key would be a credential
 * leak rather than a convenience.
 */
export function autoInjectedEnvVars(options: {
  projectId: string,
  apiUrl: string,
  publishableClientKey: string,
  secretServerKey: string,
}): Record<string, { value: string, secret: boolean }> {
  const publicValues = {
    HEXCLAVE_PROJECT_ID: options.projectId,
    HEXCLAVE_API_URL: options.apiUrl,
    HEXCLAVE_PUBLISHABLE_CLIENT_KEY: options.publishableClientKey,
  };
  const injected: Record<string, { value: string, secret: boolean }> = {
    HEXCLAVE_SECRET_SERVER_KEY: { value: options.secretServerKey, secret: true },
  };
  for (const [key, value] of Object.entries(publicValues)) {
    injected[key] = { value, secret: false };
    for (const prefix of ["NEXT_PUBLIC_", "VITE_"]) {
      injected[`${prefix}${key}`] = { value, secret: false };
    }
  }
  return injected;
}

/**
 * The project's API keys for the injected env vars, creating a key set if the
 * project has none.
 *
 * Deploying is exactly the moment a project needs these, and a deploy that
 * failed because nobody had clicked "create API key" first would be a pointless
 * step. The set is created with a publishable client key and a secret server key
 * only — never a super-secret admin key, which nothing in a deployed service
 * should hold.
 */
async function getOrCreateDeploymentApiKeys(tenancy: Tenancy): Promise<{ publishableClientKey: string, secretServerKey: string }> {
  const existing = await globalPrismaClient.apiKeySet.findFirst({
    where: {
      projectId: tenancy.project.id,
      manuallyRevokedAt: null,
      expiresAt: { gt: new Date() },
      publishableClientKey: { not: null },
      secretServerKey: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.publishableClientKey != null && existing.secretServerKey != null) {
    return { publishableClientKey: existing.publishableClientKey, secretServerKey: existing.secretServerKey };
  }
  // Far enough out that a long-lived deployment does not silently lose its
  // credentials; the dashboard can revoke it like any other key set.
  const expiresAt = new Date(Date.now() + 200 * 365 * 24 * 60 * 60 * 1000);
  const created = await globalPrismaClient.apiKeySet.create({
    data: {
      id: generateUuid(),
      projectId: tenancy.project.id,
      description: "Created automatically for deployed services",
      expiresAt,
      publishableClientKey: `pck_${generateSecureRandomString()}`,
      secretServerKey: `ssk_${generateSecureRandomString()}`,
    },
  });
  return {
    publishableClientKey: created.publishableClientKey ?? throwErr("publishableClientKey is null on a key set that was just created with one"),
    secretServerKey: created.secretServerKey ?? throwErr("secretServerKey is null on a key set that was just created with one"),
  };
}

// The deploy-file output keys mapped to the runtime's own. They happen to
// coincide today; `satisfies Record<ServiceOutputKey, …>` is what makes adding
// an output without deciding how the runtime spells it a compile error, rather
// than a `{ ref: "api.undefined" }` that blocks a deploy with no explanation.
const SERVICE_OUTPUT_KEY_TO_MARSHAL = {
  url: "url",
  hostname: "hostname",
} satisfies Record<typeof SERVICE_OUTPUT_KEYS[number], string>;

/**
 * Resolves a service's definition env vars into the EnvValue map sent to
 * Marshal:
 * - the Hexclave credentials are injected first, so a service can reach its own
 *   project with no configuration — and any explicitly declared var of the same
 *   name overrides them,
 * - plain vars pass through as literal `{ value }`s,
 * - secret vars are filled from the project's stored secrets (dashboard →
 *   Project Settings → Secrets), falling back to `secretDefaults` — the deploy
 *   request's transient copy of the `secret(key, default)` defaults from the
 *   deploy file. Defaults are deliberately NOT part of the stored definition:
 *   they are an author-side convenience that the dashboard must never surface
 *   (a stored default would make "this secret has a value" ambiguous on the
 *   secrets page). A secret with neither is a 400 that lists every missing key
 *   at once — failing loud beats silently deploying without them,
 * - `hexclave.*` connections resolve the managed Hexclave service's outputs
 *   server-side (they are backend state, not runtime state),
 * - service outputs become Marshal `{ ref }`s, validated here first against the
 *   synced target definition (a URL must name a port that exists and speaks
 *   HTTP). `hostname()` and a private `url(<port>)` are deterministic and never
 *   block. A PUBLIC `url` needs the target to be up (or a verified domain); if
 *   it never resolves, Marshal reports the service blocked and the deployment
 *   fails.
 *
 * Error messages only ever contain reference tokens (pointers), never any
 * resolved value.
 */
export async function resolveEnvVars(options: {
  tenancy: Tenancy,
  prisma: PrismaClientTransaction,
  // The service these env vars belong to; used to reject a self-referential
  // PUBLIC `url` (a service whose own public URL feeds its env could never
  // bootstrap; its private address is deterministic and fine).
  serviceId: string,
  definition: DeploymentServiceDefinition,
  // Deploy-request-only fallbacks for `secret()` env vars, keyed by ENV VAR
  // key (see deploymentSecretDefaultsSchema). Never read from the database.
  secretDefaults: Record<string, string>,
}): Promise<{
  resolvedEnv: Record<string, MarshalEnvValue>,
  redactionSecrets: string[],
}> {
  const { tenancy, prisma, serviceId, definition, secretDefaults } = options;
  const env = definition.env;
  const existingServices = await prisma.deploymentService.findMany({
    where: { tenancyId: tenancy.id },
    // isPublic decides whether a service's own url() is a cycle: a public one
    // resolves to a platform URL that does not exist yet, a private one to its
    // deterministic internal address.
    select: { serviceId: true, isPublic: true, ports: true },
  });
  const existingServicesById = new Map(existingServices.map((row) => [row.serviceId, row]));

  const resolvedEnv = new Map<string, MarshalEnvValue>();
  const redactionSecrets = new Set<string>();

  // Injected FIRST so a declared var of the same name simply overwrites it
  // below: the author's own value is what they meant.
  const apiKeys = await getOrCreateDeploymentApiKeys(tenancy);
  for (const [envVarKey, injected] of Object.entries(autoInjectedEnvVars({
    projectId: tenancy.project.id,
    apiUrl: getEnvVariable("NEXT_PUBLIC_STACK_API_URL"),
    publishableClientKey: apiKeys.publishableClientKey,
    secretServerKey: apiKeys.secretServerKey,
  }))) {
    resolvedEnv.set(envVarKey, { value: injected.value });
    if (injected.secret) redactionSecrets.add(injected.value);
  }

  // Cache per-secret reads so N env vars filled from the same secret don't
  // repeat KMS decryptions, and per-output resolution for hexclave.* outputs.
  const outputCache = new Map<string, Promise<{ value: string, secret: boolean }>>();
  const resolveHexclaveOutputCached = (outputKey: string, raw: string): Promise<{ value: string, secret: boolean }> => {
    const cached = outputCache.get(outputKey);
    if (cached != null) return cached;
    const promise = resolveHexclaveOutput(tenancy, outputKey, raw);
    outputCache.set(outputKey, promise);
    return promise;
  };
  const secretCache = new Map<string, Promise<string | null>>();
  const readSecret = (secretKey: string): Promise<string | null> => {
    const cached = secretCache.get(secretKey);
    if (cached != null) return cached;
    const promise = readProjectSecretValue(tenancy.project.id, secretKey);
    secretCache.set(secretKey, promise);
    return promise;
  };

  const missingSecretKeys: string[] = [];
  for (const [envVarKey, config] of Object.entries(env)) {
    if (!ENV_VAR_KEY_REGEX.test(envVarKey)) {
      throw new StatusError(400, `Invalid env var key: ${JSON.stringify(envVarKey)}. Keys must match ${ENV_VAR_KEY_REGEX.toString()}.`);
    }
    const normalized = normalizeEnvVarConfig(envVarKey, config);
    switch (normalized.type) {
      case "plain": {
        resolvedEnv.set(envVarKey, { value: normalized.value });
        break;
      }
      case "secret": {
        const storedValue = await readSecret(normalized.secretKey);
        // `Object.hasOwn` rather than a truthiness/`??` check on the lookup:
        // an empty-string default is a legitimate value, and a plain property
        // read would also pick up Object.prototype members for env var keys
        // like "constructor".
        const secretValue = storedValue ?? (Object.hasOwn(secretDefaults, envVarKey) ? secretDefaults[envVarKey] : undefined);
        if (secretValue == null) {
          missingSecretKeys.push(normalized.secretKey);
          break;
        }
        resolvedEnv.set(envVarKey, { value: secretValue });
        if (secretValue.length > 0) redactionSecrets.add(secretValue);
        break;
      }
      case "connection": {
        const raw = formatConnectionValue(normalized.serviceId, normalized.outputKey, normalized.port);
        // Checked before anything else, including hexclave.* outputs: only a URL
        // names a port, and anywhere else the runtime would silently discard the
        // suffix rather than resolve what the author asked for.
        if (normalized.port !== null && normalized.outputKey !== "url") {
          throw new StatusError(400, `The env var connection "${raw}" names a port, but only "url" takes one. Drop the ":${normalized.port}".`);
        }
        if (normalized.serviceId === HEXCLAVE_SERVICE_ID) {
          if (!(HEXCLAVE_OUTPUT_KEYS as readonly string[]).includes(normalized.outputKey)) {
            throw new StatusError(400, `The env var connection "${raw}" uses an unknown output. The hexclave service exposes: ${HEXCLAVE_OUTPUT_KEYS.join(", ")}.`);
          }
          const output = await resolveHexclaveOutputCached(normalized.outputKey, raw);
          resolvedEnv.set(envVarKey, { value: output.value });
          if (output.secret && output.value.length > 0) redactionSecrets.add(output.value);
          break;
        }
        if (!(SERVICE_OUTPUT_KEYS as readonly string[]).includes(normalized.outputKey)) {
          throw new StatusError(400, `The env var connection "${raw}" uses an unknown output. Deployment services expose: ${SERVICE_OUTPUT_KEYS.join(", ")}.`);
        }
        const target = existingServicesById.get(normalized.serviceId);
        if (target === undefined) {
          throw new StatusError(400, `The env var connection "${raw}" points to a service that doesn't exist in this project. Add it to a deploy file's \`services\` and deploy it first — service ids are unique across the project, so it may live in another repository's hexclave.deploy.ts.`);
        }
        const targetPorts = parseStoredPorts(target.ports, normalized.serviceId);
        if (normalized.outputKey === "url") {
          resolveUrlPortOrThrow(raw, normalized.serviceId, targetPorts, normalized.port);
          // A service's own PUBLIC url cannot exist before the service does.
          // Its private address is deterministic, so only this case is refused.
          if (normalized.serviceId === serviceId && target.isPublic) {
            throw new StatusError(400, `The env var ${JSON.stringify(envVarKey)} connects to the service's own public URL "${raw}", which cannot exist before the service does. Use ${JSON.stringify(`${serviceId}.hostname`)} for the service's own address.`);
          }
        }
        // Narrowed by the includes() check above; the map is `satisfies Record<ServiceOutputKey,…>`.
        const marshalOutputKey = SERVICE_OUTPUT_KEY_TO_MARSHAL[normalized.outputKey as typeof SERVICE_OUTPUT_KEYS[number]];
        resolvedEnv.set(envVarKey, { ref: formatConnectionValue(normalized.serviceId, marshalOutputKey, normalized.port) });
        break;
      }
    }
  }

  if (missingSecretKeys.length > 0) {
    const uniqueMissing = [...new Set(missingSecretKeys)].sort(stringCompare);
    throw new StatusError(400, `Missing values for ${uniqueMissing.length === 1 ? "secret" : "secrets"}: ${uniqueMissing.join(", ")}. All of these must be set in the dashboard under Project Settings > Secrets before this service can deploy.`);
  }

  return {
    resolvedEnv: Object.fromEntries(resolvedEnv),
    redactionSecrets: [...redactionSecrets],
  };
}

/**
 * The port a `url` reference resolves to on its target, or a clean 400. A URL
 * names ONE port: named explicitly, or implied when the target declares exactly
 * one HTTP port. The CLI rejects these at evaluation time with better messages;
 * this is the boundary that makes it true regardless of which client synced the
 * definition — and it is where a reference into another deployment source is
 * checked at all, since that file was never on this machine.
 */
function resolveUrlPortOrThrow(raw: string, targetServiceId: string, targetPorts: DeploymentPorts, namedPort: number | null): DeploymentPortEntry {
  const entries = deploymentPortEntries(targetPorts);
  const describePorts = () => entries.map((entry) => `${entry.port} (${entry.protocol})`).join(", ") || "none";
  if (namedPort === null) {
    const sole = soleHttpDeploymentPort(targetPorts);
    if (sole === null) {
      const httpCount = entries.filter((entry) => entry.protocol === "http").length;
      throw new StatusError(400, httpCount === 0
        ? `The env var connection "${raw}" requests a URL from a service that ${entries.length === 0 ? "declares no ports at all" : "declares only TCP ports"}. Connect with ${JSON.stringify(`${targetServiceId}.hostname`)} and an explicit port instead.`
        : `The env var connection "${raw}" needs exactly one HTTP port on ${JSON.stringify(targetServiceId)} to build a URL from, but it declares ${httpCount}. Name the port you want. Its ports: ${describePorts()}.`);
    }
    return deploymentPortEntry(targetPorts, sole) ?? throwErr("soleHttpDeploymentPort returned a port the record does not contain");
  }
  const match = deploymentPortEntry(targetPorts, namedPort);
  if (match === null) {
    throw new StatusError(400, `The env var connection "${raw}" names port ${namedPort}, which ${JSON.stringify(targetServiceId)} does not declare. Its ports: ${describePorts()}.`);
  }
  if (match.protocol !== "http") {
    throw new StatusError(400, `The env var connection "${raw}" names port ${namedPort}, which is TCP and therefore has no URL. Connect with ${JSON.stringify(`${targetServiceId}.hostname`)} and port ${namedPort} instead.`);
  }
  return match;
}

async function resolveHexclaveOutput(tenancy: Tenancy, outputKey: string, raw: string): Promise<{ value: string, secret: boolean }> {
  const apiUrl = getEnvVariable("NEXT_PUBLIC_STACK_API_URL");
  switch (outputKey) {
    case "projectId": {
      return { value: tenancy.project.id, secret: false };
    }
    case "apiUrl": {
      return { value: apiUrl, secret: false };
    }
    case "jwksUrl": {
      return { value: `${apiUrl.replace(/\/$/, "")}/api/v1/projects/${tenancy.project.id}/.well-known/jwks.json`, secret: false };
    }
    case "publishableClientKey":
    case "secretServerKey": {
      // The same key set the injected env vars use, created on demand — so an
      // explicit `hexclave.secretServerKey` and the automatic
      // HEXCLAVE_SECRET_SERVER_KEY are always the same credential.
      const keys = await getOrCreateDeploymentApiKeys(tenancy);
      return outputKey === "publishableClientKey"
        ? { value: keys.publishableClientKey, secret: false }
        : { value: keys.secretServerKey, secret: true };
    }
    default: {
      throw new StatusError(400, `The env var connection "${raw}" uses an unknown output. The hexclave service exposes: ${HEXCLAVE_OUTPUT_KEYS.join(", ")}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Build-log redaction

export type EncryptedDeploymentRedactionSecrets = {
  edkBase64: string,
  ciphertextBase64: string,
};

/**
 * Encrypts the exact sensitive values injected into one deployment. The snapshot
 * is deployment-scoped rather than project-scoped: request-only defaults never
 * enter the project secret store, and rotating/deleting a stored secret must not
 * make its earlier build logs unsafe to read.
 */
export async function encryptDeploymentRedactionSecrets(secretValues: string[]): Promise<EncryptedDeploymentRedactionSecrets> {
  const uniqueNonEmptyValues = [...new Set(secretValues)].filter((value) => value.length > 0);
  return await encryptWithKms(JSON.stringify(uniqueNonEmptyValues));
}

/**
 * Decrypts a deployment's complete redaction set. Missing or malformed material
 * fails closed: returning a partial set would turn a KMS/data problem into
 * plaintext credential disclosure through the logs endpoint.
 */
export async function decryptDeploymentRedactionSecrets(encrypted: Prisma.JsonValue | null): Promise<string[]> {
  if (encrypted == null) {
    throw new StatusError(409, "Build logs for this deployment are unavailable because it has no stored redaction material.");
  }
  if (!isRecord(encrypted) || typeof encrypted.edkBase64 !== "string" || typeof encrypted.ciphertextBase64 !== "string") {
    throw new HexclaveAssertionError("Stored deployment redaction material has an invalid encrypted payload; the deploy route should have written { edkBase64, ciphertextBase64 }");
  }
  const decrypted = await decryptWithKms({
    edkBase64: encrypted.edkBase64,
    ciphertextBase64: encrypted.ciphertextBase64,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch (error) {
    throw new HexclaveAssertionError("Stored deployment redaction material did not decrypt to valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new HexclaveAssertionError("Stored deployment redaction material did not decrypt to an array");
  }
  const result = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string") {
      throw new HexclaveAssertionError("Stored deployment redaction material contains a non-string value");
    }
    if (value.length > 0) result.add(value);
  }
  return [...result];
}

export function redactSecrets(text: string, secretValues: string[]): string {
  let result = text;
  // LONGEST FIRST, not caller order. Replacing a value that is a PREFIX of
  // another one first destroys the longer match and leaves its tail in the log:
  // with "abc" before "abcdef", "abcdef" becomes "<redacted>def". Sorting by
  // descending length means the longest containing value is always consumed
  // whole before any of its substrings can break it up.
  for (const secret of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue;
    result = result.split(secret).join("<redacted>");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deploying

/** Assembles the Marshal spec for a service's stored definition. */
export function marshalSpecForDefinition(definition: DeploymentServiceDefinition, resolvedEnv: Record<string, MarshalEnvValue>) {
  // A "server" is always a single instance whatever the definition says; the
  // schema and the CLI both reject other bounds, so this only applies the
  // defaults rather than overriding a stated intent, and it keeps the spec
  // self-consistent with the type Marshal re-validates against.
  const isServer = definition.type === "server";
  const minInstances = effectiveMinInstances(definition);
  return {
    config: {
      type: definition.type,
      public: definition.public === true,
      min_instances: minInstances,
      // Default max to at least min: a definition with `minInstances` and no
      // `maxInstances` must not synthesize an invalid spec (max < min) that
      // Marshal 400s after the upload is already consumed.
      max_instances: isServer ? 1 : definition.max_instances ?? Math.max(minInstances, DEFAULT_MAX_INSTANCES),
      // Passed through verbatim, minus the defaults deploymentPortEntries has
      // already applied. Visibility is NOT in here — it is `public` above, which
      // the runtime reads off the container.
      ports: Object.fromEntries(deploymentPortEntries(definition.ports).map((entry) => [
        String(entry.port),
        { protocol: entry.protocol },
      ])),
      // Absent = ephemeral container filesystem. Marshal re-validates that a
      // volume implies type "server".
      ...(definition.persistent_volumes !== undefined && Object.keys(definition.persistent_volumes).length > 0
        ? { persistent_volumes: definition.persistent_volumes }
        : {}),
      // Part of the CONTAINER rather than of the build: the runtime starts the
      // machine with it instead of the image's own entrypoint and command, so
      // changing only this rolls the machines without rebuilding anything.
      ...(definition.start_command !== undefined ? { start_command: definition.start_command } : {}),
    },
    env: resolvedEnv,
  };
}

/**
 * Creates the deployment row for one `hexclave deploy`. The number is `max + 1`
 * within the tenancy; the caller must supply a transaction (see the route) so
 * the read and the insert are atomic, and the (tenancyId, number) unique index
 * makes the residual race a retry rather than two deployments that print as the
 * same "#47".
 */
export async function createDeployment(prisma: PrismaClientTransaction, tenancy: Tenancy, options: {
  sourceRowId: string,
  triggeredBy: string,
  plannedServiceIds: string[],
  // What the client packaged, or null when it packaged nothing (an all-prebuilt
  // deploy). Stored as given: it is a listing the client already computed while
  // building the tarball, and re-deriving it would mean inflating the archive.
  sourceManifest?: DeploymentSourceManifest | null,
}): Promise<{ id: string, number: number }> {
  const latest = await prisma.deployment.findFirst({
    where: { tenancyId: tenancy.id },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return await prisma.deployment.create({
    data: {
      tenancyId: tenancy.id,
      sourceRowId: options.sourceRowId,
      number: (latest?.number ?? 0) + 1,
      triggeredBy: options.triggeredBy,
      plannedServiceIds: options.plannedServiceIds,
      // Undefined rather than null when absent, so Prisma leaves the column
      // NULL — "not recorded", which is what it means.
      ...(options.sourceManifest == null ? {} : { sourceManifest: options.sourceManifest }),
      services: Object.fromEntries(options.plannedServiceIds.map((serviceId) => [serviceId, { status: "pending" }])),
    },
    select: { id: true, number: true },
  });
}

/** One service's outcome within a deployment, as stored in `Deployment.services`. */
export type DeploymentServiceOutcome = {
  status: "pending" | "building" | "deploying" | "deployed" | "failed" | "skipped",
  url?: string | null,
  revision?: string | null,
  // The digest-pinned image this deploy actually ran for the service — what its
  // build pushed, or what its `image` reference resolved to. Null until the
  // apply has happened. Recorded per DEPLOYMENT rather than on the service,
  // because it is the answer to "what did this deploy ship", which a later
  // deploy must not overwrite.
  image?: string | null,
  error?: string | null,
};

/**
 * Returns a Map rather than a record so a lookup is typed `| undefined`: these
 * keys come from stored JSON, so "this service has no outcome" is a real answer
 * that callers must handle, and a record index would type it away.
 */
function parseStoredOutcomes(services: Prisma.JsonValue): Map<string, DeploymentServiceOutcome> {
  const parsed = new Map<string, DeploymentServiceOutcome>();
  if (!isRecord(services)) return parsed;
  for (const [serviceId, outcome] of Object.entries(services)) {
    if (!isRecord(outcome)) continue;
    const status = outcome.status;
    parsed.set(serviceId, {
      // An unknown status reads as pending rather than throwing: this renders a
      // list, and one odd row must not take the page down.
      status: status === "building" || status === "deploying" || status === "deployed" || status === "failed" || status === "skipped" ? status : "pending",
      url: typeof outcome.url === "string" ? outcome.url : null,
      revision: typeof outcome.revision === "string" ? outcome.revision : null,
      // Absent on rows written before deploys recorded it, which reads the same
      // as an apply that has not happened yet.
      image: typeof outcome.image === "string" ? outcome.image : null,
      error: typeof outcome.error === "string" ? outcome.error : null,
    });
  }
  return parsed;
}

export type StartDeploymentResult = { deploymentId: string, number: number };

/**
 * Hands a whole deployment to the runtime: one uploaded source tree, one build
 * of every service, then the applies in dependency order.
 *
 * The runtime owns that sequence rather than this function driving it step by
 * step, because the runtime is where the reconciliation lease and the build
 * completion webhook already live. What comes back immediately is only "the
 * deployment was accepted"; refreshDeploymentFromMarshal mirrors its progress.
 */
export async function startDeployment(options: {
  tenancy: Tenancy,
  prisma: PrismaClientTransaction,
  deploymentId: string,
  source: { id: string, sourceId: string },
  // In dependency order: every service in one level is applied concurrently,
  // and a level starts only once the previous one has converged.
  levels: string[][],
  definitionsByServiceId: Map<string, DeploymentServiceDefinition>,
  resolvedEnvByServiceId: Map<string, Record<string, MarshalEnvValue>>,
  // Absent when every target names an already-built image: nothing is built, so
  // there is no source archive for the runtime to consume.
  marshalUploadId: string | undefined,
}): Promise<void> {
  const { tenancy, prisma, deploymentId, source, levels, definitionsByServiceId, resolvedEnvByServiceId, marshalUploadId } = options;
  const client = getMarshalClientOrThrow();
  const ns = marshalNamespaceForTenancy(tenancy);

  const targets: MarshalDeploymentTarget[] = levels.flat().map((serviceId) => {
    const definition = definitionsByServiceId.get(serviceId) ?? throwErr(`No definition for planned service ${serviceId}`);
    const resolvedEnv = resolvedEnvByServiceId.get(serviceId) ?? throwErr(`No resolved env for planned service ${serviceId}`);
    return {
      service_key: serviceId,
      ...(definition.root_directory !== undefined ? { root_directory: definition.root_directory } : {}),
      ...(definition.dockerfile_path !== undefined ? { dockerfile_path: definition.dockerfile_path } : {}),
      // An image with no build command is not built: the runtime resolves the
      // reference to a digest and applies it, and never looks at the upload for
      // it. With one, the same field names the BASE of a build instead — which
      // is why the runtime derives "is this built" from the pair rather than
      // from `image` alone.
      ...(definition.image !== undefined ? { image: definition.image } : {}),
      ...(definition.build_command !== undefined ? { build_command: definition.build_command } : {}),
      spec: marshalSpecForDefinition(definition, resolvedEnv),
    };
  });

  let result: MarshalDeployment;
  try {
    result = await client.startSourceDeployment(ns, source.sourceId, {
      ...(marshalUploadId === undefined ? {} : { upload_id: marshalUploadId }),
      targets,
      order: levels,
    });
  } catch (e) {
    sanitizeMarshalError(e, "Starting the deployment failed");
  }

  await prisma.deployment.update({
    where: { tenancyId_id: { tenancyId: tenancy.id, id: deploymentId } },
    data: {
      marshalBuildId: result.id,
      // Taken from the runtime rather than inferred here: it is the runtime that
      // decides whether a builder machine ran, and it says so on the deployment
      // it just accepted.
      hasBuildLogs: result.has_logs,
      status: marshalDeploymentStatus(result),
      services: outcomesFromMarshal(result, levels.flat()),
    },
  });

  // Write-through for the domains of every service in this deploy. Failures
  // here must not fail the deployment itself (the build is already running), so
  // a DB/Marshal blip in domain sync must not throw — the Domains tab surfaces
  // per-domain problems on its own reads.
  try {
    await syncServiceDomainsToMarshal({ tenancy, prisma, serviceIds: levels.flat(), client });
  } catch (e) {
    captureError("deployments-domain-sync-after-deploy", e);
  }
}

function marshalDeploymentStatus(deployment: MarshalDeployment): DeploymentStatus {
  switch (deployment.status) {
    case "queued": {
      return "QUEUED";
    }
    case "building": {
      return "BUILDING";
    }
    case "deploying": {
      return "DEPLOYING";
    }
    case "succeeded": {
      return "SUCCEEDED";
    }
    case "failed": {
      return "FAILED";
    }
    case "canceled": {
      return "CANCELED";
    }
    default: {
      // The runtime added a state this build doesn't know; treat it as still
      // going so polling continues rather than wrongly finalizing the deploy.
      return "BUILDING";
    }
  }
}

function outcomesFromMarshal(deployment: MarshalDeployment, plannedServiceIds: string[]): Record<string, DeploymentServiceOutcome> {
  const byKey = new Map(deployment.services.map((service) => [service.service_key, service]));
  // Prototype-less: a service id is author-chosen and `__proto__` passes the id
  // rules, but `{}["__proto__"] = outcome` invokes the prototype setter instead
  // of creating an own property. parseStoredOutcomes reads with Object.entries,
  // so the outcome vanished between the two and the service showed as forever
  // "pending" no matter what the runtime reported.
  const outcomes: Record<string, DeploymentServiceOutcome> = Object.create(null);
  for (const serviceId of plannedServiceIds) {
    const reported = byKey.get(serviceId);
    if (reported === undefined) {
      // The runtime is not reporting on it (yet). While the deployment is still
      // going that is simply "not started"; once it is terminal the service was
      // never reached, which is what "skipped" says.
      outcomes[serviceId] = { status: deployment.finished_at_millis === null ? "pending" : "skipped" };
      continue;
    }
    outcomes[serviceId] = {
      status: reported.status,
      url: reported.url,
      revision: reported.revision,
      image: reported.image,
      error: reported.error,
    };
  }
  return outcomes;
}

export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED";
}

/**
 * Refreshes a non-terminal deployment from the runtime (poll-on-read — there is
 * no background poller). No-op when it is already terminal, or when the runtime
 * never accepted it.
 */
export async function refreshDeploymentFromMarshal(prisma: PrismaClientTransaction, tenancy: Tenancy, deployment: {
  id: string,
  status: DeploymentStatus,
  marshalBuildId: string | null,
  plannedServiceIds: Prisma.JsonValue,
  createdAt: Date,
  concludedAt: Date | null,
}): Promise<void> {
  if (isTerminalDeploymentStatus(deployment.status)) return;
  const plannedServiceIds = parsePlannedServiceIds(deployment.plannedServiceIds);

  if (deployment.marshalBuildId === null) {
    // The client died between creating this row and handing the deploy to the
    // runtime (packaging, upload, a crash). `concludedAt` is the client saying
    // it has stopped; without it the row would read as in-flight forever and
    // the dashboard would poll it for eternity.
    if (deployment.concludedAt !== null) {
      await prisma.deployment.update({
        where: { tenancyId_id: { tenancyId: tenancy.id, id: deployment.id } },
        data: {
          status: "FAILED",
          error: "The deploy stopped before the runtime accepted it — the source was never uploaded.",
          finishedAt: new Date(),
          services: Object.fromEntries(plannedServiceIds.map((serviceId) => [serviceId, { status: "skipped" }])),
        },
      });
    }
    return;
  }

  const client = getMarshalClientOrThrow();
  const ns = marshalNamespaceForTenancy(tenancy);
  let state: MarshalDeployment;
  try {
    state = await client.getDeployment(ns, deployment.marshalBuildId);
  } catch (e) {
    sanitizeMarshalError(e, "Fetching the deployment status failed");
  }

  const status = marshalDeploymentStatus(state);
  await prisma.deployment.update({
    where: { tenancyId_id: { tenancyId: tenancy.id, id: deployment.id } },
    data: {
      status,
      error: state.error,
      services: outcomesFromMarshal(state, plannedServiceIds),
      finishedAt: isTerminalDeploymentStatus(status) ? new Date(state.finished_at_millis ?? Date.now()) : null,
    },
  });

  // A deployed service is provisioned in the runtime, which is what the domain
  // routes need before they can allocate IPs.
  const deployedServiceIds = state.services.filter((service) => service.status === "deployed").map((service) => service.service_key);
  if (deployedServiceIds.length > 0) {
    await prisma.deploymentService.updateMany({
      where: { tenancyId: tenancy.id, serviceId: { in: deployedServiceIds }, provisionedAt: null },
      data: { provisionedAt: new Date() },
    });
  }
}

function parsePlannedServiceIds(plannedServiceIds: Prisma.JsonValue): string[] {
  // Planned ids come from JSON, so a hand-edited row could hold anything. An
  // empty list is better than a listing that throws.
  return Array.isArray(plannedServiceIds) && plannedServiceIds.every((id) => typeof id === "string")
    ? plannedServiceIds as string[]
    : [];
}

/**
 * Ensures every attached domain of these services is attached in Marshal and
 * mirrors the verification state back into the rows. Domains added in the
 * dashboard before the first deploy only exist as rows (Marshal has no spec to
 * attach them to yet), so this runs on every deploy to push them once the
 * service is provisioned — and it self-heals rows that drifted afterwards.
 *
 * Intentionally tolerant: a domain Marshal rejects (e.g. claimed by another
 * namespace) is recorded as unverified rather than failing the caller — the
 * Domains tab shows per-domain state and errors.
 */
export async function syncServiceDomainsToMarshal(options: {
  tenancy: Tenancy,
  prisma: PrismaClientTransaction,
  serviceIds: string[],
  client: MarshalClient,
}): Promise<void> {
  const { tenancy, prisma, serviceIds, client } = options;
  if (serviceIds.length === 0) return;
  const ns = marshalNamespaceForTenancy(tenancy);
  const domains = await prisma.deploymentDomain.findMany({
    where: { tenancyId: tenancy.id, serviceId: { in: serviceIds } },
  });
  for (const domain of domains) {
    if (domain.serviceId === null) continue;
    // null = the check didn't complete; the row is left untouched then, so a
    // transient Marshal/network error during a deploy can't clobber a
    // previously-verified domain back to unverified (which would also make
    // `<service>.url` connections resolve to the wrong URL until re-checked).
    let verified: boolean | null = null;
    try {
      const result = await client.putDomain(ns, domain.hostname, domain.serviceId);
      verified = result.verified;
    } catch (e) {
      // NOTHING here may fail the caller — the build is already running, so a domain hiccup
      // must not turn a started deploy into an error. Only 400/409 are real per-domain
      // answers (bad hostname / claimed elsewhere) → record unverified. 404/408/429/5xx are
      // transient or not about this domain → leave the row untouched (verified stays null),
      // so a rate limit can't clobber a genuinely-verified domain back to unverified.
      if (e instanceof MarshalApiError && (e.status === 400 || e.status === 409)) {
        verified = false;
      } else {
        captureError("deployments-domain-sync", e);
      }
    }
    if (verified != null) {
      await prisma.deploymentDomain.update({
        where: { tenancyId_id: { tenancyId: tenancy.id, id: domain.id } },
        data: { verified },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// API shapes

export type DnsRecord = MarshalDnsRecord;

export type DeploymentApiShape = {
  id: string,
  number: number,
  deployment_source_id: string,
  status: "queued" | "building" | "deploying" | "deployed" | "failed" | "canceled",
  triggered_by: string,
  created_at_millis: number,
  finished_at_millis: number | null,
  error: string | null,
  has_build_logs: boolean,
  // What this deploy packaged, or null when it packaged nothing (every service
  // ran an already-built image) and on rows written before it was recorded.
  source_manifest: DeploymentSourceManifest | null,
  services: {
    service_id: string,
    status: DeploymentServiceOutcome["status"],
    url: string | null,
    revision: string | null,
    // The digest-pinned image this deploy ran for the service. Null until its
    // apply has happened (and on deployments from before this was recorded).
    image: string | null,
    error: string | null,
  }[],
};

export type DeploymentServiceApiShape = {
  id: string,
  deployment_source_id: string,
  type: DeploymentServiceType,
  // Whether the service takes public ingress. A property of the SERVICE: the
  // runtime serves every declared port on every address the service has, so
  // there is no such thing as a public port with a private sibling.
  public: boolean,
  // The declared ports, keyed by port number.
  ports: DeploymentPorts,
  min_instances: number | null,
  max_instances: number | null,
  root_directory: string | null,
  // Null = built with Railpack auto-detection rather than a Dockerfile.
  dockerfile_path: string | null,
  // The image this service runs — or, with a build_command, the base it is built
  // on — as the deploy file named it (canonical and fully qualified, e.g.
  // "docker.io/library/postgres:16"). Null = no image was named, in which case
  // the two fields above say what the build starts from.
  image: string | null,
  // A single command line run while the image is built (null = none), and one
  // run as the container's process instead of the image's own (null = the image
  // decides). The start command is applied at run time, so it never builds.
  build_command: string | null,
  start_command: string | null,
  // Null = no persistent disk (an ephemeral container filesystem). Otherwise a
  // single-entry record keyed by volume id.
  persistent_volumes: Record<string, { path: string, size_gb: number }> | null,
  provisioned: boolean,
  status: "not_deployed" | "queued" | "building" | "deploying" | "deployed" | "failed" | "canceled",
  has_successful_deploy: boolean,
  url: string | null,
  // The definition's env vars, normalized: `value` is the literal value for
  // plain vars and the "serviceId.outputKey" reference for connections;
  // `secret_key` names the secret for secret vars (their values are
  // write-only, so there is nothing else to show).
  env: { key: string, type: "plain" | "secret" | "connection", value: string | null, secret_key: string | null }[],
  domains: { hostname: string, port: number | null, is_primary: boolean, verified: boolean }[],
  latest_deployment_id: string | null,
};

const DEPLOYMENT_STATUS_TO_API = {
  QUEUED: "queued",
  BUILDING: "building",
  DEPLOYING: "deploying",
  SUCCEEDED: "deployed",
  FAILED: "failed",
  CANCELED: "canceled",
} satisfies Record<DeploymentStatus, DeploymentApiShape["status"]>;

/**
 * `full` includes the source manifest; `summary` omits it.
 *
 * The manifest is per-deployment and can hold MAX_SOURCE_MANIFEST_ENTRIES files,
 * and the dashboard polls the LIST endpoint every few seconds while a deploy is
 * in flight. Shipping every manifest in every page of that poll costs orders of
 * magnitude more than the listing itself, to populate a tab the reader may never
 * open — so only the single-deployment read carries it.
 */
export type DeploymentApiDetail = "full" | "summary";

export function deploymentToApiShape(deployment: {
  id: string,
  number: number,
  status: DeploymentStatus,
  triggeredBy: string,
  createdAt: Date,
  finishedAt: Date | null,
  error: string | null,
  marshalBuildId: string | null,
  hasBuildLogs: boolean,
  plannedServiceIds: Prisma.JsonValue,
  services: Prisma.JsonValue,
  sourceManifest: Prisma.JsonValue | null,
  source: { sourceId: string },
}, detail: DeploymentApiDetail = "full"): DeploymentApiShape {
  const outcomes = parseStoredOutcomes(deployment.services);
  const plannedServiceIds = parsePlannedServiceIds(deployment.plannedServiceIds);
  // Union, planned order first: an outcome whose service is missing from the
  // plan (a hand-edited row) must still show rather than vanish.
  const serviceIds = [...plannedServiceIds, ...[...outcomes.keys()].filter((serviceId) => !plannedServiceIds.includes(serviceId))];
  return {
    id: deployment.id,
    number: deployment.number,
    deployment_source_id: deployment.source.sourceId,
    status: DEPLOYMENT_STATUS_TO_API[deployment.status],
    triggered_by: deployment.triggeredBy,
    created_at_millis: deployment.createdAt.getTime(),
    finished_at_millis: deployment.finishedAt?.getTime() ?? null,
    error: deployment.error,
    // The build is what produces a log, so a deployment the runtime never
    // accepted has none to offer.
    // Both halves matter: a deployment the runtime never accepted has no log to
    // fetch, and one that built nothing produced no log to fetch.
    has_build_logs: deployment.marshalBuildId !== null && deployment.hasBuildLogs,
    // Parsed rather than passed through: it comes out of a JSON column, so a row
    // written by an older client must degrade to "no manifest" instead of
    // reaching the dashboard as some other shape.
    source_manifest: detail === "full" ? parseSourceManifest(deployment.sourceManifest) : null,
    services: serviceIds.map((serviceId) => {
      const outcome = outcomes.get(serviceId) ?? { status: "pending" as const };
      return {
        service_id: serviceId,
        status: outcome.status,
        url: outcome.url ?? null,
        revision: outcome.revision ?? null,
        image: outcome.image ?? null,
        error: outcome.error ?? null,
      };
    }),
  };
}

export async function serviceToApiShape(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  row: DeploymentServiceRow,
}): Promise<DeploymentServiceApiShape> {
  const { prisma, tenancy, row } = options;
  const volume = await getServiceVolume(prisma, tenancy, row.serviceId);
  const definition = definitionFromServiceRow(row, volume);

  // The newest deployment that PLANNED this service, whatever became of it.
  // Read from the deployments themselves rather than from a column on the
  // service, so there is no second copy of the truth to drift.
  const recentDeployments = await prisma.deployment.findMany({
    where: { tenancyId: tenancy.id, sourceRowId: row.sourceRowId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, status: true, services: true, plannedServiceIds: true },
  });
  const involving = recentDeployments.filter((deployment) => parsePlannedServiceIds(deployment.plannedServiceIds).includes(row.serviceId));
  // `.at`, not `[0]`: an index is typed as always-present without
  // noUncheckedIndexedAccess, which would type away the empty case this
  // function exists to handle (a service that has never been deployed).
  const latest = involving.at(0) ?? null;
  const latestOutcome = latest === null ? null : parseStoredOutcomes(latest.services).get(row.serviceId) ?? null;
  const hasSuccessfulDeploy = involving.some((deployment) => parseStoredOutcomes(deployment.services).get(row.serviceId)?.status === "deployed");

  const status = ((): DeploymentServiceApiShape["status"] => {
    if (latestOutcome === null) return "not_deployed";
    switch (latestOutcome.status) {
      case "pending": {
        return "queued";
      }
      case "building": {
        return "building";
      }
      case "deploying": {
        return "deploying";
      }
      case "deployed": {
        return "deployed";
      }
      case "failed": {
        return "failed";
      }
      case "skipped": {
        return "canceled";
      }
    }
  })();

  const domainRows = await prisma.deploymentDomain.findMany({
    where: { tenancyId: tenancy.id, serviceId: row.serviceId },
    orderBy: { hostname: "asc" },
  });

  // A verified custom domain remains the preferred user-facing URL; a public
  // service falls back to the platform URL from the last deploy that produced
  // one. Keep using an older successful deploy's URL after a later failure: the
  // previous machines (and their endpoint) can still be serving.
  const entries = deploymentPortEntries(definition.ports);
  const servesHttp = entries.some((entry) => entry.protocol === "http");
  const verifiedPrimary = domainRows.find((domain) => domain.isPrimary && domain.verified) ?? domainRows.find((domain) => domain.verified);
  const lastDeployedUrl = involving
    .map((deployment) => parseStoredOutcomes(deployment.services).get(row.serviceId)?.url ?? null)
    .find((url) => url != null) ?? null;
  const url = !servesHttp
    ? null
    : verifiedPrimary != null
      ? `https://${verifiedPrimary.hostname}`
      : definition.public === true ? lastDeployedUrl : null;

  const env: DeploymentServiceApiShape["env"] = [];
  for (const [envVarKey, config] of Object.entries(definition.env)) {
    // Tolerate incomplete entries (possible in hand-edited rows — see
    // normalizeEnvVarConfig): one bad entry must not take down the whole
    // service list. Deploys of this service still fail loudly on it.
    let normalized;
    try {
      normalized = normalizeEnvVarConfig(envVarKey, config);
    } catch (e) {
      if (!(e instanceof StatusError)) throw e;
      captureError("deployments-env-var-config-invalid", new HexclaveAssertionError(`Skipping invalid deployment env var config entry ${JSON.stringify(envVarKey)} of service ${JSON.stringify(row.serviceId)}`, { cause: e }));
      continue;
    }
    env.push({
      key: envVarKey,
      type: normalized.type,
      // formatConnectionValue, not hand-concatenation: dropping the `:port`
      // reports a DIFFERENT reference than the one stored — `api.url` instead
      // of `api.url:9090` — which on a multi-port target is not merely lossy
      // but invalid, and is what the dashboard renders.
      value: normalized.type === "plain" ? normalized.value : normalized.type === "connection" ? formatConnectionValue(normalized.serviceId, normalized.outputKey, normalized.port) : null,
      secret_key: normalized.type === "secret" ? normalized.secretKey : null,
    });
  }
  env.sort((a, b) => stringCompare(a.key, b.key));

  return {
    id: row.serviceId,
    deployment_source_id: row.source.sourceId,
    type: definition.type,
    public: definition.public === true,
    ports: definition.ports,
    min_instances: row.minInstances,
    max_instances: row.maxInstances,
    root_directory: row.rootDirectory,
    dockerfile_path: row.dockerfilePath,
    image: row.image,
    build_command: row.buildCommand,
    start_command: row.startCommand,
    persistent_volumes: definition.persistent_volumes ?? null,
    provisioned: row.provisionedAt != null,
    status,
    has_successful_deploy: hasSuccessfulDeploy,
    url,
    env,
    domains: domainRows
      .map((domain) => ({
        hostname: domain.hostname,
        port: domain.port,
        is_primary: domain.isPrimary,
        verified: domain.verified,
      }))
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || stringCompare(a.hostname, b.hostname)),
    latest_deployment_id: latest?.id ?? null,
  };
}
