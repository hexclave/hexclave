// View-model for the Deployments board, backed by the real deployments API
// (project.listDeploymentServices() and friends). The board shows the managed
// Hexclave service (synthetic — it always exists and can't be edited) plus one
// node per deployment service from the project config.

import { CubeIcon, HexagonIcon } from "@phosphor-icons/react";
import type { AdminDeploymentJson, AdminDeploymentServiceJson } from "@hexclave/next";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import type { Accent } from "./variants";

export type ServiceType = "hexclave" | "container";

// Node states shown on the board; a superset of the API's service status so
// the managed Hexclave node and never-deployed services render meaningfully.
export type ServiceStatus = "deployed" | "building" | "not_deployed" | "crashed" | "canceled" | "skipped";

// The colours deployment sources are assigned from, in order. Excludes the
// purple the managed Hexclave node always uses, so a source can never be
// confused for it.
export const SOURCE_ACCENTS: Accent[] = ["cyan", "amber", "rose", "blue", "green", "indigo"];

/**
 * The colour of a deployment source's services on the map.
 *
 * A pure function of the source id (FNV-1a, then into SOURCE_ACCENTS) rather
 * than an index into the sources on screen: a source keeps its colour as other
 * sources come and go, and as the map is scoped to different deployments, so a
 * reader can learn "cyan is the backend" once. Two sources CAN collide on a
 * colour — the node also names its source, and stable colours are worth more
 * here than guaranteed-distinct ones.
 */
export function accentForDeploymentSource(sourceId: string): Accent {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sourceId.length; index++) {
    hash ^= sourceId.charCodeAt(index);
    // FNV prime, via shifts to stay inside 32 bits without bigint.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return SOURCE_ACCENTS[hash % SOURCE_ACCENTS.length];
}

/** How a deploy's outcome for one service reads as a node state. */
export function outcomeStatusToBoardStatus(status: AdminDeploymentJson["services"][number]["status"]): ServiceStatus {
  switch (status) {
    case "pending":
    case "building":
    case "deploying": {
      return "building";
    }
    case "deployed": {
      return "deployed";
    }
    case "failed": {
      return "crashed";
    }
    case "skipped": {
      return "skipped";
    }
  }
}

// Mirrors the API's normalized env var shape: "plain" vars carry their literal
// value, "connection" vars carry the "serviceId.outputKey" reference they
// resolve to at deploy time, and "secret" vars carry only the secret key whose
// value lives in the write-only per-project secret store (Project Settings >
// Secrets).
export type EnvVar = {
  key: string,
  type: "plain" | "secret" | "connection",
  value: string | null,
  secretKey: string | null,
};

export type BoardService = {
  // The service id — the key of the `services` record returned by the deploy
  // file's `deploy` export, or "hexclave" for the managed service.
  id: string,
  name: string,
  type: ServiceType,
  // Which deploy file declares this service; null for the managed Hexclave
  // node, which belongs to no source.
  sourceId: string | null,
  // Colour of the node, its icon chip and its outgoing edges. Derived from the
  // deployment source, so services from one repository read as a group.
  accent: Accent,
  // Position on the board, in board-pixel space (top-left corner of the node).
  x: number,
  y: number,
  status: ServiceStatus,
  // Human-facing "what is this" line under the service name.
  source: string,
  domain?: string,
  envVars: EnvVar[],
  // The raw API object for container services; null for the managed Hexclave one.
  api: AdminDeploymentServiceJson | null,
};

// Fixed node footprint. Kept constant so the connection-line geometry can be
// computed deterministically from positions alone (see connections.ts) rather
// than measuring DOM on every drag frame.
export const NODE_WIDTH = 256;
export const NODE_HEIGHT = 108;

export type ServiceOutput = {
  key: string,
  label: string,
  secret?: boolean,
};

// The outputs each service *type* exposes for other services' connection env
// vars (referenced as `serviceId.outputKey`). Must stay in sync with the
// server-side resolver (apps/backend/src/lib/deployments — resolveEnvVars).
const OUTPUTS_BY_TYPE = new Map<ServiceType, ServiceOutput[]>([
  ["hexclave", [
    { key: "projectId", label: "Project ID" },
    { key: "apiUrl", label: "API URL" },
    { key: "jwksUrl", label: "JWKS URL" },
    { key: "publishableClientKey", label: "Publishable client key" },
    { key: "secretServerKey", label: "Secret server key", secret: true },
  ]],
  ["container", [
    { key: "url", label: "Public URL" },
    { key: "internalUrl", label: "Internal URL" },
    { key: "internalHost", label: "Internal host" },
  ]],
]);

export function getServiceOutputs(type: ServiceType): ServiceOutput[] {
  return OUTPUTS_BY_TYPE.get(type) ?? [];
}

export type ServiceTypeMeta = {
  label: string,
  icon: React.ElementType,
  // Semantic accent used by badges, node accent bars, and connection lines.
  accent: "purple" | "cyan" | "green",
  hint: string,
};

export const SERVICE_TYPE_META = new Map<ServiceType, ServiceTypeMeta>([
  ["hexclave", {
    label: "Hexclave",
    icon: HexagonIcon,
    accent: "purple",
    hint: "Your Hexclave backend. Exactly one per project.",
  }],
  ["container", {
    label: "Container",
    icon: CubeIcon,
    accent: "cyan",
    hint: "A container built from your source (Railpack auto-detected, or your Dockerfile) or pulled from a public image registry, deployed with `hexclave deploy`.",
  }],
]);

export function getServiceTypeMeta(type: ServiceType): ServiceTypeMeta {
  const meta = SERVICE_TYPE_META.get(type);
  if (!meta) throw new Error(`Unknown service type: ${type}`);
  return meta;
}

export function apiStatusToBoardStatus(status: AdminDeploymentServiceJson["status"]): ServiceStatus {
  switch (status) {
    case "not_deployed": {
      return "not_deployed";
    }
    case "queued":
    case "building":
    case "deploying": {
      return "building";
    }
    case "deployed": {
      return "deployed";
    }
    case "failed": {
      return "crashed";
    }
    case "canceled": {
      return "canceled";
    }
  }
}

/**
 * The ports of a service as an ascending list. The API sends them keyed by port
 * number (the shape the deploy file writes), and object key order would put
 * "80" after "8080".
 */
export function portEntriesOf(ports: AdminDeploymentServiceJson["ports"]): { port: number, protocol: "http" | "tcp" }[] {
  return Object.entries(ports)
    .map(([portKey, definition]) => ({
      port: Number(portKey),
      protocol: definition.protocol,
    }))
    .filter((entry) => Number.isInteger(entry.port))
    .sort((a, b) => a.port - b.port);
}

/**
 * When a deployment's state became the project's state. A deployment that never
 * finished has only its start to go on.
 */
function deploymentTime(deployment: AdminDeploymentJson): number {
  return deployment.finished_at_millis ?? deployment.created_at_millis;
}

export type BoardScope = {
  // Services to draw, and what each one's state was at the scoped moment.
  statusByServiceId: Map<string, ServiceStatus>,
  outcomeByServiceId: Map<string, AdminDeploymentJson["services"][number]>,
  visibleServiceIds: Set<string>,
  // Which deployment each source's state was read from — the legend names it,
  // so a reader can see that the map mixes "this deploy" with "whatever the
  // other repository had running at the time".
  deploymentBySourceId: Map<string, AdminDeploymentJson | null>,
};

/**
 * The whole project's services as of the moment `openDeployment` completed, not
 * just the ones that deploy shipped.
 *
 * A project deployed from several repositories has a source per repository, and
 * they deploy independently: to show what was running when one of them
 * finished, every OTHER source contributes its own newest deployment at or
 * before that moment. The open deployment always speaks for its own source,
 * even against a newer sibling, because it is the one the reader opened.
 *
 * Only `deployments` that the caller has loaded are considered. A source whose
 * deployments are all newer than the scoped moment had not deployed yet, so its
 * services are hidden; a source with no loaded deployments at all is unknown
 * rather than absent (its history may be past the end of the loaded page), so
 * its services are shown with their current status instead of being silently
 * dropped from the map.
 */
export function buildDeploymentScope(options: {
  openDeployment: AdminDeploymentJson,
  deployments: AdminDeploymentJson[],
  apiServices: AdminDeploymentServiceJson[],
}): BoardScope {
  const { openDeployment, deployments, apiServices } = options;
  const asOf = deploymentTime(openDeployment);

  const deploymentsBySource = new Map<string, AdminDeploymentJson[]>();
  for (const deployment of deployments) {
    const list = deploymentsBySource.get(deployment.deployment_source_id) ?? [];
    list.push(deployment);
    deploymentsBySource.set(deployment.deployment_source_id, list);
  }

  const statusByServiceId = new Map<string, ServiceStatus>();
  const outcomeByServiceId = new Map<string, AdminDeploymentJson["services"][number]>();
  const visibleServiceIds = new Set<string>();
  const deploymentBySourceId = new Map<string, AdminDeploymentJson | null>();

  const serviceIdsBySource = new Map<string, string[]>();
  for (const apiService of apiServices) {
    const list = serviceIdsBySource.get(apiService.deployment_source_id) ?? [];
    list.push(apiService.id);
    serviceIdsBySource.set(apiService.deployment_source_id, list);
  }

  for (const [sourceId, serviceIds] of serviceIdsBySource) {
    const loaded = deploymentsBySource.get(sourceId) ?? [];
    const effective = sourceId === openDeployment.deployment_source_id
      ? openDeployment
      : loaded
        .filter((deployment) => deploymentTime(deployment) <= asOf)
        // Newest first; `number` breaks a tie between two deploys that finished
        // in the same millisecond.
        .sort((a, b) => deploymentTime(b) - deploymentTime(a) || b.number - a.number)
        .at(0) ?? null;

    if (effective === null) {
      // Nothing loaded for this source at all — unknown, not absent. Fall back
      // to current state so the map does not quietly lose a repository.
      if (loaded.length === 0) {
        deploymentBySourceId.set(sourceId, null);
        for (const serviceId of serviceIds) visibleServiceIds.add(serviceId);
      }
      continue;
    }

    deploymentBySourceId.set(sourceId, effective);
    for (const outcome of effective.services) {
      // A service the deploy shipped that no longer exists has no definition to
      // draw a node from, so it cannot be shown here.
      if (!serviceIds.includes(outcome.service_id)) continue;
      visibleServiceIds.add(outcome.service_id);
      outcomeByServiceId.set(outcome.service_id, outcome);
      statusByServiceId.set(outcome.service_id, outcomeStatusToBoardStatus(outcome.status));
    }
  }

  return { statusByServiceId, outcomeByServiceId, visibleServiceIds, deploymentBySourceId };
}

function hostnameOfUrl(url: string | null): string | undefined {
  if (url == null) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Builds the board view-model from the API service list. Positions are a
 * deterministic layout (managed service on the left, deployment services in
 * columns to the right); the board applies the user's in-session drag offsets
 * on top.
 */
export function buildBoardServices(
  apiServices: AdminDeploymentServiceJson[],
  hexclaveApiHost: string,
  // Node state per service id. Supplied by the caller because the board is
  // scoped to a point in time: what a service's state WAS then is read from the
  // deployments, not from the service's current row. A service with no entry
  // falls back to its current status.
  statusByServiceId?: Map<string, ServiceStatus>,
): BoardService[] {
  const services: BoardService[] = [{
    id: "hexclave",
    name: "hexclave",
    type: "hexclave",
    sourceId: null,
    accent: "purple",
    x: 96,
    y: 200,
    status: "deployed",
    source: "Hexclave managed backend",
    domain: hexclaveApiHost,
    envVars: [],
    api: null,
  }];
  // The config schema rejects a "hexclave" service id, but stay defensive:
  // a shadowing entry would collide with the synthetic managed node's key.
  apiServices
    .filter((apiService) => apiService.id !== "hexclave")
    // Grouped by deployment source before positions are assigned, so one
    // repository's services land together (the layout fills a column at a time)
    // rather than interleaving with another's.
    .sort((a, b) => stringCompare(a.deployment_source_id, b.deployment_source_id) || stringCompare(a.id, b.id))
    .forEach((apiService, index) => {
      services.push({
        id: apiService.id,
        name: apiService.id,
        type: "container",
        sourceId: apiService.deployment_source_id,
        accent: accentForDeploymentSource(apiService.deployment_source_id),
        x: 520 + Math.floor(index / 4) * 320,
        y: 96 + (index % 4) * 150,
        status: statusByServiceId?.get(apiService.id) ?? apiStatusToBoardStatus(apiService.status),
        // Names every port and whether the SERVICE is public — the board node is
        // where a reader checks what a service actually exposes. Public is stated
        // once, for the service, because that is where it is true: every port of
        // a public service is reachable. Sorted by port NUMBER, since the ports
        // arrive keyed by it.
        source: portEntriesOf(apiService.ports).length > 0
          ? `${apiService.public ? "Public" : "Private"} container on ${portEntriesOf(apiService.ports).length === 1 ? "port" : "ports"} ${portEntriesOf(apiService.ports).map((entry) => `${entry.port}${entry.protocol === "tcp" ? " (tcp)" : ""}`).join(", ")}`
          : "Deployed with `hexclave deploy`",
        domain: apiService.domains.find((d) => d.is_primary)?.hostname ?? hostnameOfUrl(apiService.url),
        envVars: apiService.env.map((envVar) => ({
          key: envVar.key,
          type: envVar.type,
          value: envVar.value,
          secretKey: envVar.secret_key,
        })),
        api: apiService,
      });
    });
  return services;
}
