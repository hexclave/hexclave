import http from "node:http";
import { createHash } from "node:crypto";

const EXPECTED_TOKEN = process.env.HEXCLAVE_GCP_MOCK_TOKEN ?? "mock_hexclave_gcp_key";
let projectNumber = 100000000000;
let operationNumber = 0;
let instanceNumber = 0;
let addressNumber = 0;
let revisionNumber = 0;
const projects = new Map();
const faults = { apiActivationResponses: 0, operationPolls: 0 };
const operations = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

function error(res, status, message) {
  return sendJson(res, status, { error: { code: status, message, status: status === 404 ? "NOT_FOUND" : "FAILED_PRECONDITION" } });
}

function digest(image) {
  const named = /@sha256:([0-9a-f]{64})$/i.exec(image ?? "");
  return named === null ? `sha256:${createHash("sha256").update(image ?? "unknown").digest("hex")}` : `sha256:${named[1]}`;
}

function pinImage(image) {
  if (image.includes("@")) return image;
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  const repository = lastColon > lastSlash ? image.slice(0, lastColon) : image;
  return `${repository}@${digest(image)}`;
}

function operation(host, apiVersion = "v1") {
  const name = `operations/mock-${++operationNumber}`;
  const value = { name, done: faults.operationPolls === 0 };
  operations.set(`${host}/${apiVersion}/${name}`, { remaining: faults.operationPolls, value: { name, done: true, response: {} } });
  return value;
}

function computeOperation(projectId, scope = "global") {
  return {
    selfLink: `https://compute.googleapis.com/compute/v1/projects/${projectId}/${scope}/operations/mock-${++operationNumber}`,
    status: "DONE",
  };
}

function makeProject(body) {
  const number = String(++projectNumber);
  return {
    name: `projects/${number}`,
    projectId: body.projectId,
    displayName: body.displayName,
    parent: body.parent ?? null,
    labels: body.labels ?? {},
    state: "ACTIVE",
    number,
    billingAccount: null,
    apis: new Set(),
    iamPolicy: { version: 3, etag: `etag-${number}`, bindings: [] },
    repositories: new Map(),
    cloudRunServices: new Map(),
    revisions: new Map(),
    computeResources: new Map(),
    certificates: new Map(),
    certificateMaps: new Map(),
    certificateMapEntries: new Map(),
    disks: new Map(),
    instances: new Map(),
    logs: [],
  };
}

function projectJson(project) {
  return {
    name: project.name,
    projectId: project.projectId,
    displayName: project.displayName,
    parent: project.parent,
    labels: project.labels,
    state: project.state,
  };
}

function introspectionProject(project) {
  return {
    ...projectJson(project),
    projectNumber: project.number,
    billingAccount: project.billingAccount,
    apis: [...project.apis],
    iamPolicy: project.iamPolicy,
    repositories: [...project.repositories.values()],
    cloudRunServices: [...project.cloudRunServices.values()].map(({ stale, staleReadsRemaining, ...service }) => service),
    revisions: [...project.revisions.values()],
    computeResources: [...project.computeResources.entries()].map(([path, resource]) => ({ path, resource })),
    certificates: [...project.certificates.values()],
    certificateMaps: [...project.certificateMaps.values()],
    certificateMapEntries: [...project.certificateMapEntries.values()],
    disks: [...project.disks.values()],
    instances: [...project.instances.values()],
    logs: project.logs,
  };
}

function metadataValue(instance, key) {
  return instance.metadata?.items?.find((item) => item.key === key)?.value ?? null;
}

function appendLog(project, resource, textPayload, labels = {}) {
  project.logs.push({
    insertId: `mock-log-${project.logs.length + 1}`,
    timestamp: new Date().toISOString(),
    logName: `projects/${project.projectId}/logs/${encodeURIComponent("stdout")}`,
    resource,
    labels,
    textPayload,
  });
}

function parseServiceImage(startupScript) {
  const match = /^readonly IMAGE='([^']+)'$/m.exec(startupScript ?? "");
  return match?.[1] ?? "unknown";
}

function projectFromPath(path) {
  const match = /\/projects\/([^/:]+)/.exec(path);
  return match === null ? null : projects.get(decodeURIComponent(match[1])) ?? null;
}

function computeResourcePath(path) {
  const match = /^\/compute\/v1\/projects\/[^/]+(\/.*)$/.exec(path);
  return match?.[1] ?? null;
}

function computeCollectionAndName(resourcePath) {
  const match = /^(.*\/(?:networks|subnetworks|firewalls|addresses|networkEndpointGroups|backendServices|urlMaps|sslCertificates|targetHttpsProxies|forwardingRules))(?:\/([^/]+))?$/.exec(resourcePath);
  return match === null ? null : { collection: match[1], name: match[2] ?? null };
}

function serializeComputeResource(project, collection, body) {
  const resource = { ...body, selfLink: `https://compute.googleapis.com/compute/v1/projects/${project.projectId}${collection}/${body.name}`, status: "READY" };
  if (collection.endsWith("/addresses")) resource.address = `203.0.113.${++addressNumber}`;
  if (collection.endsWith("/urlMaps")) resource.fingerprint = `fingerprint-${++operationNumber}`;
  if (collection.endsWith("/sslCertificates")) {
    const hostname = body.managed?.domains?.[0] ?? "";
    resource.managed = { ...body.managed, status: hostname.endsWith(".verified.test") ? "ACTIVE" : "PROVISIONING" };
  }
  return resource;
}

function resetState() {
  projects.clear();
  operations.clear();
  faults.apiActivationResponses = 0;
  faults.operationPolls = 0;
  projects.set("mock-platform", makeProject({
    projectId: "mock-platform",
    displayName: "Mock platform",
    parent: "organizations/mock-organization",
    labels: { purpose: "marshal-platform" },
  }));
}

function handleResourceManager(req, res, path, url, body) {
  if (path === "/v3/projects:search" && req.method === "GET") {
    const id = (url.searchParams.get("query") ?? "").replace(/^id:/, "");
    const project = projects.get(id);
    return sendJson(res, 200, { projects: project === undefined ? [] : [projectJson(project)] });
  }
  if (path === "/v3/projects" && req.method === "POST") {
    if (typeof body?.displayName !== "string" || body.displayName.length > 30) return error(res, 400, "field [project.display_name] has issue [project display name must be at most 30 characters]");
    if (projects.has(body.projectId)) return error(res, 409, "Requested entity already exists");
    projects.set(body.projectId, makeProject(body));
    return sendJson(res, 200, operation("cloudresourcemanager.googleapis.com", "v3"));
  }
  const v3Project = /^\/v3\/projects\/([^/]+)$/.exec(path);
  if (v3Project !== null) {
    const project = projects.get(decodeURIComponent(v3Project[1]));
    if (project === undefined) return error(res, 403, "The caller does not have permission");
    if (req.method === "GET") return sendJson(res, 200, projectJson(project));
    if (req.method === "DELETE") {
      projects.delete(project.projectId);
      return sendJson(res, 200, operation("cloudresourcemanager.googleapis.com", "v3"));
    }
  }
  const iam = /^\/v1\/projects\/([^:]+):(getIamPolicy|setIamPolicy)$/.exec(path);
  if (iam !== null) {
    const project = projects.get(decodeURIComponent(iam[1]));
    if (project === undefined) return error(res, 404, "Project not found");
    if (iam[2] === "getIamPolicy") return sendJson(res, 200, project.iamPolicy);
    project.iamPolicy = body.policy;
    return sendJson(res, 200, project.iamPolicy);
  }
  return error(res, 404, `mock: unhandled Resource Manager request ${req.method} ${path}`);
}

function handleBilling(req, res, path, body) {
  const match = /^\/v1\/projects\/([^/]+)\/billingInfo$/.exec(path);
  if (match === null || req.method !== "PUT") return error(res, 404, `mock: unhandled Billing request ${req.method} ${path}`);
  const project = projects.get(decodeURIComponent(match[1]));
  if (project === undefined) return error(res, 404, "Project not found");
  project.billingAccount = body.billingAccountName;
  return sendJson(res, 200, { projectId: project.projectId, billingAccountName: project.billingAccount, billingEnabled: true });
}

function handleServiceUsage(req, res, path, body) {
  const enable = /^\/v1\/projects\/([^/]+)\/services:batchEnable$/.exec(path);
  if (enable !== null && req.method === "POST") {
    const project = projects.get(decodeURIComponent(enable[1]));
    if (project === undefined) return error(res, 404, "Project not found");
    for (const service of body.serviceIds ?? []) project.apis.add(service);
    return sendJson(res, 200, operation("serviceusage.googleapis.com", "v1"));
  }
  const identity = /^\/v1beta1\/projects\/([^/]+)\/services\/([^:]+):generateServiceIdentity$/.exec(path);
  if (identity !== null && req.method === "POST") return sendJson(res, 200, { name: "operations/finished.DONE_OPERATION" });
  return error(res, 404, `mock: unhandled Service Usage request ${req.method} ${path}`);
}

function handleArtifactRegistry(req, res, path, url, body) {
  const project = projectFromPath(path);
  if (project === null) return error(res, 404, "Project not found");
  const specific = /^\/v1\/projects\/[^/]+\/locations\/([^/]+)\/repositories\/([^/]+)$/.exec(path);
  if (specific !== null && req.method === "GET") {
    const repository = project.repositories.get(decodeURIComponent(specific[2]));
    return repository === undefined ? error(res, 404, "Repository not found") : sendJson(res, 200, repository);
  }
  const collection = /^\/v1\/projects\/[^/]+\/locations\/([^/]+)\/repositories$/.exec(path);
  if (collection !== null && req.method === "POST") {
    const repositoryId = url.searchParams.get("repositoryId");
    const repository = { ...body, name: `projects/${project.projectId}/locations/${collection[1]}/repositories/${repositoryId}` };
    project.repositories.set(repositoryId, repository);
    return sendJson(res, 200, operation("artifactregistry.googleapis.com", "v1"));
  }
  return error(res, 404, `mock: unhandled Artifact Registry request ${req.method} ${path}`);
}

function handleCloudRun(req, res, host, path, url, body) {
  const revisionMatch = /^\/apis\/serving\.knative\.dev\/v1\/namespaces\/([^/]+)\/revisions\/([^/]+)$/.exec(path);
  if (revisionMatch !== null && req.method === "GET") {
    const project = projects.get(decodeURIComponent(revisionMatch[1]));
    const revision = project?.revisions.get(decodeURIComponent(revisionMatch[2]));
    return revision === undefined ? error(res, 404, "Revision not found") : sendJson(res, 200, revision);
  }
  const project = projectFromPath(path);
  if (project === null) return error(res, 404, "Project not found");
  const collection = /^\/v2\/projects\/[^/]+\/locations\/([^/]+)\/services$/.exec(path);
  if (collection !== null && req.method === "POST") {
    if (body.name !== undefined) return error(res, 400, "Violation in CreateServiceRequest.service: service.name must be empty on CreateServiceRequest.");
    const serviceId = url.searchParams.get("serviceId");
    return applyCloudRun(res, project, collection[1], serviceId, body, null);
  }
  const specific = /^\/v2\/projects\/[^/]+\/locations\/([^/]+)\/services\/([^/]+)$/.exec(path);
  if (specific !== null) {
    const serviceId = decodeURIComponent(specific[2]);
    const existing = project.cloudRunServices.get(serviceId);
    if (req.method === "GET") {
      if (existing === undefined) return error(res, 404, "Service not found");
      if (existing.staleReadsRemaining > 0 && existing.stale !== null) {
        existing.staleReadsRemaining--;
        return sendJson(res, 200, existing.stale);
      }
      const { stale, staleReadsRemaining, ...service } = existing;
      return sendJson(res, 200, service);
    }
    if (req.method === "PATCH") {
      if (existing === undefined) return error(res, 404, "Service not found");
      if (body.name !== `projects/${project.projectId}/locations/${specific[1]}/services/${serviceId}`) return error(res, 400, "Service name must match the resource name on update");
      // Real Cloud Run reads `updateMask=*` as an EMPTY field list: it answers 200 with a
      // done operation and leaves the service exactly as it was, without validating the
      // body. Reproduced because a mock that helpfully applied the update hid a real bug —
      // every update silently no-opped against live Cloud Run while the suite stayed green.
      if (url.searchParams.get("updateMask") === "*") return sendJson(res, 200, operation("run.googleapis.com", "v2"));
      return applyCloudRun(res, project, specific[1], serviceId, body, existing);
    }
    if (req.method === "DELETE") {
      if (existing === undefined) return error(res, 404, "Service not found");
      project.cloudRunServices.delete(serviceId);
      return sendJson(res, 200, operation("run.googleapis.com", "v2"));
    }
  }
  return error(res, 404, `mock: unhandled Cloud Run request ${req.method} ${host}${path}`);
}

const SERIAL_PREFIX = "[   32.663629] google_metadata_script_runner_adapt[791]: startup-script: ";

function applyCloudRun(res, project, region, serviceId, body, previous) {
  const revisionName = `${serviceId}-${String(++revisionNumber).padStart(5, "0")}`;
  const image = body.template?.containers?.[0]?.image ?? "unknown";
  const imageDigest = digest(image);
  const service = {
    ...body,
    name: `projects/${project.projectId}/locations/${region}/services/${serviceId}`,
    uid: `mock-${serviceId}`,
    uri: `https://${serviceId}-${createHash("sha256").update(project.projectId).digest("hex").slice(0, 8)}.${region}.run.app`,
    latestReadyRevision: `projects/${project.projectId}/locations/${region}/services/${serviceId}/revisions/${revisionName}`,
    latestCreatedRevision: `projects/${project.projectId}/locations/${region}/services/${serviceId}/revisions/${revisionName}`,
    terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
    reconciling: false,
    stale: previous === null ? null : { ...previous, stale: undefined, staleReadsRemaining: undefined },
    staleReadsRemaining: previous === null ? 0 : 1,
  };
  project.cloudRunServices.set(serviceId, service);
  project.revisions.set(revisionName, { metadata: { name: revisionName }, status: { imageDigest } });
  appendLog(project, { type: "cloud_run_revision", labels: { project_id: project.projectId, service_name: serviceId, revision_name: revisionName, location: region } }, `Cloud Run revision ${revisionName} ready`);
  return sendJson(res, 200, operation("run.googleapis.com", "v2"));
}

function handleCompute(req, res, path, body) {
  const project = projectFromPath(path);
  if (project === null) return error(res, 404, "Project not found");
  if (faults.apiActivationResponses > 0) {
    faults.apiActivationResponses--;
    return error(res, 403, `Compute Engine API has not been used in project ${project.projectId} before or it is disabled. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`);
  }
  const resourcePath = computeResourcePath(path);
  if (resourcePath === null) return error(res, 404, `mock: invalid Compute request ${path}`);
  if (/\/operations\//.test(resourcePath) && req.method === "GET") return sendJson(res, 200, { selfLink: `https://compute.googleapis.com${path}`, status: "DONE" });

  const diskSpecific = /^\/zones\/([^/]+)\/disks\/([^/]+)$/.exec(resourcePath);
  if (diskSpecific !== null) {
    const disk = project.disks.get(decodeURIComponent(diskSpecific[2]));
    if (req.method === "GET") return disk === undefined ? error(res, 404, "Disk not found") : sendJson(res, 200, disk);
    if (req.method === "DELETE") {
      if (disk === undefined) return error(res, 404, "Disk not found");
      project.disks.delete(disk.name);
      return sendJson(res, 200, computeOperation(project.projectId, `zones/${diskSpecific[1]}`));
    }
  }
  const diskCollection = /^\/zones\/([^/]+)\/disks$/.exec(resourcePath);
  if (diskCollection !== null && req.method === "POST") {
    const disk = { ...body, id: String(++operationNumber), status: "READY", sizeGb: String(body.sizeGb) };
    project.disks.set(body.name, disk);
    return sendJson(res, 200, computeOperation(project.projectId, `zones/${diskCollection[1]}`));
  }
  const resize = /^\/zones\/([^/]+)\/disks\/([^/]+)\/resize$/.exec(resourcePath);
  if (resize !== null && req.method === "POST") {
    const disk = project.disks.get(decodeURIComponent(resize[2]));
    if (disk === undefined) return error(res, 404, "Disk not found");
    if (Number(body.sizeGb) <= Number(disk.sizeGb)) return error(res, 400, "Disk size cannot be decreased");
    disk.sizeGb = String(body.sizeGb);
    return sendJson(res, 200, computeOperation(project.projectId, `zones/${resize[1]}`));
  }

  const serial = /^\/zones\/([^/]+)\/instances\/([^/]+)\/serialPort$/.exec(resourcePath);
  if (serial !== null && req.method === "GET") {
    const instance = project.instances.get(decodeURIComponent(serial[2]));
    return instance === undefined ? error(res, 404, "Instance not found") : sendJson(res, 200, { contents: instance.serialOutput, start: "0", next: String(instance.serialOutput.length) });
  }
  const instanceSpecific = /^\/zones\/([^/]+)\/instances\/([^/]+)$/.exec(resourcePath);
  if (instanceSpecific !== null) {
    const instance = project.instances.get(decodeURIComponent(instanceSpecific[2]));
    if (req.method === "GET") return instance === undefined ? error(res, 404, "Instance not found") : sendJson(res, 200, instance);
    if (req.method === "DELETE") {
      if (instance === undefined) return error(res, 404, "Instance not found");
      project.instances.delete(instance.name);
      appendLog(project, { type: "gce_instance", labels: { project_id: project.projectId, instance_id: instance.id, zone: instanceSpecific[1] } }, `Instance ${instance.name} deleted`);
      return sendJson(res, 200, computeOperation(project.projectId, `zones/${instanceSpecific[1]}`));
    }
  }
  const instanceCollection = /^\/zones\/([^/]+)\/instances$/.exec(resourcePath);
  if (instanceCollection !== null && req.method === "POST") {
    // Compute Engine rejects this combination outright. Reproduced because the mock happily
    // created the instance, so the builder VM's invalid scheduling only surfaced on a real
    // deploy — every test and the live test (which never builds from source) passed.
    const machineType = String(body.machineType ?? "").split("/").at(-1) ?? "";
    if (machineType.startsWith("e2-") && body.scheduling?.onHostMaintenance === "TERMINATE" && body.scheduling?.provisioningModel !== "SPOT") {
      return error(res, 400, "e2 instances do not support onHostMaintenance=TERMINATE unless they are preemptible.");
    }
    const startupScript = body.metadata?.items?.find((item) => item.key === "startup-script")?.value ?? "";
    const revision = body.metadata?.items?.find((item) => item.key === "hexclave-revision")?.value ?? null;
    const image = parseServiceImage(startupScript);
    const id = String(++instanceNumber);
    const instance = {
      ...body,
      id,
      status: "RUNNING",
      networkInterfaces: [{ ...body.networkInterfaces?.[0], networkIP: `10.128.0.${instanceNumber + 10}` }],
      // Prefixed exactly as the real serial console does. A mock that emitted bare markers at
      // the start of a line hid a line-anchored parser that could never match real output.
      serialOutput: revision === null
        ? `${SERIAL_PREFIX}MARSHAL_BUILD_COMPLETE 0\n`
        : `${SERIAL_PREFIX}MARSHAL_IMAGE_REF ${pinImage(image)}\n${SERIAL_PREFIX}MARSHAL_SERVICE_READY ${revision}\n`,
    };
    project.instances.set(body.name, instance);
    appendLog(project, { type: "gce_instance", labels: { project_id: project.projectId, instance_id: id, zone: instanceCollection[1] } }, `Instance ${body.name} ready`, { instanceId: id });
    return sendJson(res, 200, computeOperation(project.projectId, `zones/${instanceCollection[1]}`));
  }

  const generic = computeCollectionAndName(resourcePath);
  if (generic !== null) {
    if (generic.name !== null) {
      const key = `${generic.collection}/${generic.name}`;
      const resource = project.computeResources.get(key);
      if (req.method === "GET") return resource === undefined ? error(res, 404, "Resource not found") : sendJson(res, 200, resource);
      if (req.method === "DELETE") {
        if (resource === undefined) return error(res, 404, "Resource not found");
        project.computeResources.delete(key);
        return sendJson(res, 200, computeOperation(project.projectId));
      }
      if (req.method === "PUT") {
        if (resource === undefined) return error(res, 404, "Resource not found");
        if (!generic.collection.endsWith("/urlMaps")) return error(res, 405, "Only URL maps support update in this mock");
        if (body.fingerprint !== resource.fingerprint) return error(res, 412, "Invalid fingerprint");
        for (const matcher of body.pathMatchers ?? []) {
          const backendMatch = /^https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/([^/]+)(\/global\/backendServices\/[^/]+)$/.exec(matcher.defaultService ?? "");
          if (backendMatch === null) return error(res, 400, "Invalid cross-project backend service reference");
          const backendProject = projects.get(decodeURIComponent(backendMatch[1]));
          if (backendProject === undefined || !backendProject.computeResources.has(backendMatch[2])) return error(res, 404, "Cross-project backend service not found");
          if (backendProject.parent !== project.parent) return error(res, 400, "Cross-project backend service must belong to the same organization");
        }
        const updated = serializeComputeResource(project, generic.collection, body);
        project.computeResources.set(key, updated);
        return sendJson(res, 200, computeOperation(project.projectId));
      }
    } else if (req.method === "POST") {
      const resource = serializeComputeResource(project, generic.collection, body);
      project.computeResources.set(`${generic.collection}/${body.name}`, resource);
      return sendJson(res, 200, computeOperation(project.projectId, generic.collection.startsWith("/regions/") ? generic.collection.split("/").slice(1, 3).join("/") : "global"));
    }
  }
  return error(res, 404, `mock: unhandled Compute request ${req.method} ${resourcePath}`);
}

function handleCertificateManager(req, res, path, url, body) {
  const project = projectFromPath(path);
  if (project === null) return error(res, 404, "Project not found");
  const entry = /^\/v1\/projects\/[^/]+\/locations\/global\/certificateMaps\/([^/]+)\/certificateMapEntries\/([^/]+)$/.exec(path);
  if (entry !== null) {
    const key = `${decodeURIComponent(entry[1])}/${decodeURIComponent(entry[2])}`;
    const resource = project.certificateMapEntries.get(key);
    if (req.method === "GET") return resource === undefined ? error(res, 404, "Certificate map entry not found") : sendJson(res, 200, resource);
    if (req.method === "DELETE") {
      if (resource === undefined) return error(res, 404, "Certificate map entry not found");
      project.certificateMapEntries.delete(key);
      return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
    }
  }
  const entryCollection = /^\/v1\/projects\/[^/]+\/locations\/global\/certificateMaps\/([^/]+)\/certificateMapEntries$/.exec(path);
  if (entryCollection !== null && req.method === "POST") {
    const mapId = decodeURIComponent(entryCollection[1]);
    if (!project.certificateMaps.has(mapId)) return error(res, 404, "Certificate map not found");
    const id = url.searchParams.get("certificateMapEntryId");
    const certificates = body.certificates ?? [];
    if (!certificates.every((name) => project.certificates.has(name.split("/").at(-1)))) return error(res, 404, "Certificate not found");
    const resource = { ...body, name: `projects/${project.projectId}/locations/global/certificateMaps/${mapId}/certificateMapEntries/${id}`, state: "ACTIVE" };
    project.certificateMapEntries.set(`${mapId}/${id}`, resource);
    return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
  }
  const map = /^\/v1\/projects\/[^/]+\/locations\/global\/certificateMaps\/([^/]+)$/.exec(path);
  if (map !== null) {
    const id = decodeURIComponent(map[1]);
    const resource = project.certificateMaps.get(id);
    if (req.method === "GET") return resource === undefined ? error(res, 404, "Certificate map not found") : sendJson(res, 200, resource);
    if (req.method === "DELETE") {
      if (resource === undefined) return error(res, 404, "Certificate map not found");
      if ([...project.certificateMapEntries.keys()].some((key) => key.startsWith(`${id}/`))) return error(res, 400, "Certificate map is in use");
      project.certificateMaps.delete(id);
      return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
    }
  }
  const mapCollection = /^\/v1\/projects\/[^/]+\/locations\/global\/certificateMaps$/.exec(path);
  if (mapCollection !== null && req.method === "POST") {
    const id = url.searchParams.get("certificateMapId");
    const resource = { ...body, name: `projects/${project.projectId}/locations/global/certificateMaps/${id}` };
    project.certificateMaps.set(id, resource);
    return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
  }
  const certificate = /^\/v1\/projects\/[^/]+\/locations\/global\/certificates\/([^/]+)$/.exec(path);
  if (certificate !== null) {
    const id = decodeURIComponent(certificate[1]);
    const resource = project.certificates.get(id);
    if (req.method === "GET") return resource === undefined ? error(res, 404, "Certificate not found") : sendJson(res, 200, resource);
    if (req.method === "DELETE") {
      if (resource === undefined) return error(res, 404, "Certificate not found");
      project.certificates.delete(id);
      return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
    }
  }
  const certificateCollection = /^\/v1\/projects\/[^/]+\/locations\/global\/certificates$/.exec(path);
  if (certificateCollection !== null && req.method === "POST") {
    const id = url.searchParams.get("certificateId");
    const hostname = body.managed?.domains?.[0] ?? "";
    const resource = { ...body, name: `projects/${project.projectId}/locations/global/certificates/${id}`, managed: { ...body.managed, state: hostname.endsWith(".verified.test") ? "ACTIVE" : "PROVISIONING" } };
    project.certificates.set(id, resource);
    return sendJson(res, 200, operation("certificatemanager.googleapis.com", "v1"));
  }
  return error(res, 404, `mock: unhandled Certificate Manager request ${req.method} ${path}`);
}

function handleLogging(req, res, path, body) {
  if (path !== "/v2/entries:list" || req.method !== "POST") return error(res, 404, `mock: unhandled Logging request ${req.method} ${path}`);
  const projectId = body.resourceNames?.[0]?.replace(/^projects\//, "");
  const project = projects.get(projectId);
  if (project === undefined) return error(res, 404, "Project not found");
  const service = /resource\.labels\.service_name="([^"]+)"/.exec(body.filter ?? "")?.[1];
  const instance = /resource\.labels\.instance_id="([^"]+)"/.exec(body.filter ?? "")?.[1];
  const since = /timestamp>="([^"]+)"/.exec(body.filter ?? "")?.[1];
  const entries = project.logs.filter((entry) => service === undefined || entry.resource.labels.service_name === service)
    .filter((entry) => instance === undefined || entry.resource.labels.instance_id === instance)
    .filter((entry) => since === undefined || entry.timestamp >= since)
    .slice(0, body.pageSize ?? 1000);
  return sendJson(res, 200, { entries });
}

function handleOperation(req, res, host, path) {
  if (req.method !== "GET") return false;
  const versionAndName = /^(?:\/(v1beta1|v1|v2|v3))?\/(operations\/[^/]+)$/.exec(path);
  if (versionAndName === null) return false;
  const key = `${host}/${versionAndName[1] ?? "v1"}/${versionAndName[2]}`;
  const stored = operations.get(key);
  if (stored === undefined) return false;
  if (stored.remaining > 0) {
    stored.remaining--;
    return sendJson(res, 200, { name: stored.value.name, done: false });
  }
  return sendJson(res, 200, stored.value);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return sendJson(res, 200, { status: "ok" });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw === "" ? null : JSON.parse(raw);
  if (req.headers.authorization !== `Bearer ${EXPECTED_TOKEN}`) return error(res, 401, "Invalid GCP mock token");
  if (url.pathname === "/__mock/reset" && req.method === "POST") {
    resetState();
    return sendJson(res, 200, { reset: true });
  }
  if (url.pathname === "/__mock/projects" && req.method === "GET") return sendJson(res, 200, { projects: [...projects.values()].map(introspectionProject) });
  if (url.pathname === "/__mock/faults" && req.method === "PUT") {
    if (typeof body?.apiActivationResponses === "number") faults.apiActivationResponses = body.apiActivationResponses;
    if (typeof body?.operationPolls === "number") faults.operationPolls = body.operationPolls;
    return sendJson(res, 200, faults);
  }
  const match = /^\/googleapis\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (match === null) return error(res, 404, `mock: unhandled path ${req.method} ${url.pathname}`);
  const host = match[1];
  const path = match[2];
  if (handleOperation(req, res, host, path) !== false) return;
  if (host === "cloudresourcemanager.googleapis.com") return handleResourceManager(req, res, path, url, body);
  if (host === "cloudbilling.googleapis.com") return handleBilling(req, res, path, body);
  if (host === "serviceusage.googleapis.com") return handleServiceUsage(req, res, path, body);
  if (host === "artifactregistry.googleapis.com") return handleArtifactRegistry(req, res, path, url, body);
  if (host === "run.googleapis.com" || host.endsWith("-run.googleapis.com")) return handleCloudRun(req, res, host, path, url, body);
  if (host === "compute.googleapis.com") return handleCompute(req, res, path, body);
  if (host === "certificatemanager.googleapis.com") return handleCertificateManager(req, res, path, url, body);
  if (host === "logging.googleapis.com") return handleLogging(req, res, path, body);
  return error(res, 404, `mock: unhandled Google API host ${host}`);
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (caught) {
    if (!res.headersSent) error(res, 500, String(caught));
    else res.end();
  }
});

resetState();

const port = Number(process.env.HEXCLAVE_GCP_MOCK_PORT ?? "8080");
server.listen(port, () => console.log(`gcp-mock listening on ${port}`));
