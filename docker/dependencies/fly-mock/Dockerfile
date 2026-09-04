FROM node:22-slim

# A minimal in-memory mock of the subset of the Fly.io APIs used by Marshal
# (apps/marshal/src/fly/client.ts): the Machines REST API, the certs/IP GraphQL
# API, and the HTTP logs API. Used by e2e tests and local development so CI
# never talks to real Fly.
#
# Deterministic behaviors tests rely on:
# - Machines are "started" immediately on create/update/start; /wait returns
#   instantly. Every machine lifecycle event appends a line to the app's logs.
# - Hostnames ending in ".verified.test" get clientStatus "Ready" immediately;
#   all others stay "Awaiting configuration" with DNS-validation records.
# - Adding a hostname that already exists on the SAME app errors with
#   "Hostname already exists on app" — but duplicates ACROSS apps are allowed,
#   matching real Fly (the smoke test proved Fly does not enforce cross-app
#   uniqueness; Marshal's own domain registry is what yields the 409).
# - The logs API mimics Fly's auth quirk: it REJECTS "Bearer <token>" and only
#   accepts the raw token as the authorization header (Marshal's client depends
#   on this difference staying visible in dev).
# - A machine's `image_ref` reports the image its config named, resolved to a
#   deterministic digest (sha256 of the reference). Marshal reads this to record
#   which bytes a deploy ran, since it does not resolve images itself.
# - GET /__mock/apps and /__mock/apps/:name expose full app state (machines
#   with env/metadata, certs, IPs) for test assertions. The whole /__mock
#   namespace requires the mock token: machine env holds RESOLVED deployment
#   secrets, so it is not something to hand out unauthenticated.

WORKDIR /app

RUN cat <<'EOF' > server.mjs
import http from "node:http";
import { createHash } from "node:crypto";

const EXPECTED_TOKEN = "mock_hexclave_fly_key";

let machineCounter = 0;
let volumeCounter = 0;
let ipCounter = 0;
let certCounter = 0;
// Seed from the real clock: Marshal's log cursor is `sinceMillis * 1e6` from wall-clock time,
// so a hard-coded epoch would put every synthetic log line before every cursor and make all
// cursor-based reads (runtime logs, live/durable build logs) return nothing.
let logNanos = BigInt(Date.now()) * 1_000_000n;
const appsByName = new Map();

function sendJson(res, status, body) {
  // Connection: close on every response: Marshal's HTTP client otherwise
  // races this server's keep-alive idle close through the docker port proxy,
  // which surfaces as multi-second request stalls in tests. The mock has no
  // performance requirements, so per-request connections are the simple fix.
  res.writeHead(status, { "content-type": "application/json", "connection": "close" });
  res.end(JSON.stringify(body));
}

function makeApp(name, orgSlug, network) {
  return {
    name,
    orgSlug,
    network: network ?? "default",
    status: "deployed",
    machinesById: new Map(),
    volumesById: new Map(),
    certsByHostname: new Map(),
    sharedIpv4: null,
    dedicatedIps: [],
    logs: [],
  };
}

// --- Volume attachment ------------------------------------------------------
// A Fly volume is claimed by at most one machine at a time. These three helpers
// keep `attached_machine_id` honest so the mock reproduces the 412 that real Fly
// returns for a double claim, rather than silently allowing a fleet to share a disk.

function mountedVolumeIds(config) {
  return (config?.mounts ?? []).map((mount) => mount.volume).filter((id) => typeof id === "string");
}

// Returns an error body when `config` claims a volume held by a DIFFERENT
// machine, otherwise null. `selfMachineId` is the machine doing the claiming
// (null when it doesn't exist yet), whose own claims are always allowed.
function claimVolumesOrError(app, config, selfMachineId) {
  for (const volumeId of mountedVolumeIds(config)) {
    const volume = app.volumesById.get(volumeId);
    if (!volume) return { error: `failed_precondition: volume ${volumeId} not found` };
    if (volume.attached_machine_id !== null && volume.attached_machine_id !== selfMachineId) {
      return { error: `failed_precondition: volume already claimed by machine ${volume.attached_machine_id}` };
    }
  }
  return null;
}

function attachVolumes(app, machine) {
  for (const volumeId of mountedVolumeIds(machine.config)) {
    const volume = app.volumesById.get(volumeId);
    if (volume) volume.attached_machine_id = machine.id;
  }
}

function detachVolumes(app, machineId) {
  for (const volume of app.volumesById.values()) {
    if (volume.attached_machine_id === machineId) volume.attached_machine_id = null;
  }
}

function appendLog(app, message, { instance = null, provider = "runner", level = "info" } = {}) {
  // Stamp at REAL wall-clock time (nanoseconds), kept strictly monotonic. Marshal's cursor is
  // `sinceMillis * 1e6` from real time, so a pure counter would drift behind real `now` and
  // make cursor-based reads (runtime logs, live/durable build logs) miss recent lines.
  const nowNanos = BigInt(Date.now()) * 1_000_000n;
  logNanos = nowNanos > logNanos ? nowNanos : logNanos + 1_000_000n;
  app.logs.push({
    id: `mocklog-${logNanos}`,
    nanos: logNanos,
    attributes: {
      timestamp: new Date(Number(logNanos / 1_000_000n)).toISOString(),
      message,
      level,
      instance,
      region: "mock",
      meta: { event: provider === null ? null : { provider } },
    },
  });
}

// Real Fly RESOLVES a machine's image and reports what it resolved to. Marshal
// does not resolve images itself, so this is the only place a digest comes from
// for a service that named a tag — mocked deterministically (a hash of the
// reference) so a tag maps to one stable digest across a test run, and so two
// different tags never collide.
function imageRefJson(image) {
  if (typeof image !== "string" || image === "") return undefined;
  const atIndex = image.indexOf("@");
  const beforeDigest = atIndex === -1 ? image : image.slice(0, atIndex);
  const lastSlashIndex = beforeDigest.lastIndexOf("/");
  const colonIndex = beforeDigest.indexOf(":", lastSlashIndex + 1);
  const name = colonIndex === -1 ? beforeDigest : beforeDigest.slice(0, colonIndex);
  const tag = colonIndex === -1 ? undefined : beforeDigest.slice(colonIndex + 1);
  const firstSlash = name.indexOf("/");
  const hasRegistry = firstSlash !== -1 && /[.:]/.test(name.slice(0, firstSlash));
  return {
    registry: hasRegistry ? name.slice(0, firstSlash) : "registry-1.docker.io",
    repository: hasRegistry ? name.slice(firstSlash + 1) : name,
    tag,
    // A reference that already names a digest resolves to itself; anything else
    // gets the deterministic stand-in.
    digest: atIndex === -1 ? `sha256:${createHash("sha256").update(image).digest("hex")}` : image.slice(atIndex + 1),
  };
}

function machineJson(machine) {
  return {
    id: machine.id,
    name: machine.name,
    state: machine.state,
    region: machine.region,
    instance_id: machine.instanceId,
    image_ref: imageRefJson(machine.config?.image),
    config: machine.config,
  };
}

function certJson(cert) {
  const verified = cert.hostname.endsWith(".verified.test");
  const labels = cert.hostname.split(".");
  return {
    id: cert.id,
    hostname: cert.hostname,
    configured: verified,
    acmeDnsConfigured: verified,
    clientStatus: verified ? "Ready" : "Awaiting configuration",
    dnsValidationHostname: `_acme-challenge.${cert.hostname}`,
    dnsValidationTarget: `${cert.hostname}.mock00.flydns.net.`,
    isApex: labels.length <= 2,
    issued: { nodes: verified ? [{ type: "rsa", expiresAt: "2100-01-01T00:00:00Z" }] : [] },
  };
}

function graphqlError(res, message, code) {
  sendJson(res, 200, { data: null, errors: [{ message, extensions: { code } }] });
}

function handleGraphql(res, body) {
  const query = body.query ?? "";
  const vars = body.variables ?? {};
  if (query.includes("allocateIpAddress")) {
    const { appId, type } = vars.input ?? {};
    const app = appsByName.get(appId);
    if (!app) return graphqlError(res, `Could not find App "${appId}"`, "NOT_FOUND");
    if (type === "shared_v4") {
      app.sharedIpv4 = app.sharedIpv4 ?? "66.51.0.1";
      return sendJson(res, 200, { data: { allocateIpAddress: { ipAddress: null, app: { name: app.name, sharedIpAddress: app.sharedIpv4 } } } });
    }
    const ip = {
      id: `ip_mock${++ipCounter}`,
      address: type === "private_v6" ? `fdaa:0:mock::${ipCounter}` : `2a09:8280:mock::${ipCounter}`,
      type,
    };
    app.dedicatedIps.push(ip);
    return sendJson(res, 200, { data: { allocateIpAddress: { ipAddress: ip, app: { name: app.name } } } });
  }
  if (query.includes("releaseIpAddress")) {
    const { appId, ipAddressId, ip } = vars.input ?? {};
    const app = appsByName.get(appId);
    if (!app) return graphqlError(res, `Could not find App "${appId}"`, "NOT_FOUND");
    if (ip !== undefined && app.sharedIpv4 === ip) app.sharedIpv4 = null;
    if (ipAddressId !== undefined) app.dedicatedIps = app.dedicatedIps.filter((entry) => entry.id !== ipAddressId);
    return sendJson(res, 200, { data: { releaseIpAddress: { app: { name: app.name, sharedIpAddress: app.sharedIpv4 } } } });
  }
  if (query.includes("addCertificate")) {
    const { appId, hostname } = vars;
    const app = appsByName.get(appId);
    if (!app) return graphqlError(res, `Could not find App "${appId}"`, "NOT_FOUND");
    if (app.certsByHostname.has(hostname)) {
      return graphqlError(res, "Hostname already exists on app", "UNPROCESSABLE");
    }
    const cert = { id: `cert_mock${++certCounter}`, hostname };
    app.certsByHostname.set(hostname, cert);
    return sendJson(res, 200, { data: { addCertificate: { certificate: certJson(cert) } } });
  }
  if (query.includes("deleteCertificate")) {
    const { appId, hostname } = vars;
    const app = appsByName.get(appId);
    if (!app) return graphqlError(res, `Could not find App "${appId}"`, "NOT_FOUND");
    const cert = app.certsByHostname.get(hostname);
    if (!cert) return graphqlError(res, `Could not find Certificate for "${hostname}"`, "NOT_FOUND");
    app.certsByHostname.delete(hostname);
    return sendJson(res, 200, { data: { deleteCertificate: { certificate: { id: cert.id, hostname } } } });
  }
  // Everything else is the app read query (ips, certificate, certificates).
  // Real Fly answers reads on a nonexistent app with a "Could not find App" ERROR, not a
  // null app — Marshal's client relies on that (its allowNotFound path). Match it so the
  // path has coverage and the mock doesn't diverge from production.
  const app = appsByName.get(vars.app);
  if (!app) return graphqlError(res, `Could not find App "${vars.app}"`, "NOT_FOUND");
  const certificate = vars.hostname !== undefined && app.certsByHostname.has(vars.hostname)
    ? certJson(app.certsByHostname.get(vars.hostname))
    : null;
  return sendJson(res, 200, {
    data: {
      app: {
        name: app.name,
        sharedIpAddress: app.sharedIpv4,
        ipAddresses: { nodes: app.dedicatedIps },
        certificate,
        certificates: { nodes: [...app.certsByHostname.values()].map(certJson) },
      },
    },
  });
}

const server = http.createServer(async (req, res) => {
  // Guaranteed-response wrapper: a single unhandled throw in this async handler (a malformed
  // BigInt cursor, a bad JSON body, a client disconnect mid-body) would otherwise become an
  // unhandled rejection and kill the process, taking down every remaining test in the job.
  try {
    await handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: String(error) });
    else res.end();
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const auth = req.headers.authorization ?? "";

  // The /__mock namespace is AUTHENTICATED, unlike the vercel-mock's. Its listing
  // returns each machine's full env, which for a deployments test run is the
  // RESOLVED deployment environment — every project secret, decrypted. An
  // unauthenticated dump of that is worth a token even in a dev-only container,
  // and /__mock/reset is destructive to a running test besides. The compose file
  // also binds this port to loopback so it is not reachable from the LAN.
  if (path.startsWith("/__mock/")) {
    if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
      return sendJson(res, 401, { error: "Invalid token in mock (the /__mock namespace expects the mock_hexclave_fly_key token)" });
    }
  }

  // Test-only reset: wipe all in-memory state so a fresh test run (or beforeAll) starts clean
  // and the mock's app/log maps don't grow unbounded across a container's lifetime.
  if (path === "/__mock/reset") {
    appsByName.clear();
    return sendJson(res, 200, { reset: true });
  }

  // Test-only introspection. The listing includes machine metadata/env so e2e
  // tests can find the app belonging to a (namespace, service key) pair without
  // knowing Marshal's naming scheme (machines carry hexclave_ns/hexclave_key
  // metadata).
  if (path === "/__mock/apps") {
    return sendJson(res, 200, {
      apps: [...appsByName.values()].map((app) => ({
        name: app.name,
        sharedIpv4: app.sharedIpv4,
        dedicatedIps: app.dedicatedIps,
        machines: [...app.machinesById.values()].map((machine) => ({
          id: machine.id,
          image: machine.config.image,
          metadata: machine.config.metadata ?? {},
          env: machine.config.env ?? {},
          mounts: machine.config.mounts ?? [],
          // What the machine is started with, when it overrides the image's own
          // entrypoint/command. Exposed alongside env and mounts because it is
          // the same kind of fact — part of what Marshal asked the machine to be
          // — and a test that asserts a service's start command has no other way
          // to see it.
          init: machine.config.init ?? null,
        })),
        volumes: [...app.volumesById.values()],
        certificates: [...app.certsByHostname.values()].map(certJson),
      })),
    });
  }
  const mockAppMatch = /^\/__mock\/apps\/([^/]+)$/.exec(path);
  if (mockAppMatch) {
    const app = appsByName.get(mockAppMatch[1]);
    if (!app) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, {
      name: app.name,
      network: app.network,
      sharedIpv4: app.sharedIpv4,
      dedicatedIps: app.dedicatedIps,
      machines: [...app.machinesById.values()].map(machineJson),
      volumes: [...app.volumesById.values()],
      certificates: [...app.certsByHostname.values()].map(certJson),
    });
  }

  // Logs API: mimics Fly's auth quirk — raw token only, "Bearer <token>" is a 401.
  const logsMatch = /^\/api\/v1\/apps\/([^/]+)\/logs$/.exec(path);
  if (logsMatch) {
    if (auth !== EXPECTED_TOKEN) {
      res.writeHead(401, { "connection": "close" });
      return res.end();
    }
    const app = appsByName.get(logsMatch[1]);
    if (!app) {
      res.writeHead(401, { "connection": "close" }); // real Fly can't distinguish missing apps here either
      return res.end();
    }
    const nextToken = url.searchParams.get("next_token");
    const instance = url.searchParams.get("instance");
    const after = nextToken === null ? -1n : BigInt(nextToken);
    const entries = app.logs
      .filter((entry) => entry.nanos > after)
      .filter((entry) => instance === null || entry.attributes.instance === instance)
      .slice(0, 100);
    const lastNanos = entries.length > 0 ? entries[entries.length - 1].nanos : null;
    return sendJson(res, 200, {
      data: entries.map((entry) => ({ id: entry.id, type: "logs", attributes: entry.attributes })),
      meta: { next_token: lastNanos === null ? "" : String(lastNanos) },
    });
  }

  if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
    return sendJson(res, 401, { error: "Invalid token in mock (expected the mock_hexclave_fly_key token)" });
  }

  if (path === "/graphql" && req.method === "POST") {
    return handleGraphql(res, JSON.parse(rawBody));
  }

  if (path === "/v1/apps" && req.method === "POST") {
    const body = JSON.parse(rawBody);
    if (appsByName.has(body.app_name)) {
      return sendJson(res, 422, { error: "Name has already been taken" });
    }
    appsByName.set(body.app_name, makeApp(body.app_name, body.org_slug, body.network));
    return sendJson(res, 201, { id: body.app_name, created_at: Date.now() });
  }

  const appMatch = /^\/v1\/apps\/([^/]+)(\/.*)?$/.exec(path);
  if (!appMatch) {
    return sendJson(res, 404, { error: `mock: unhandled path ${req.method} ${path}` });
  }
  const appName = appMatch[1];
  const subPath = appMatch[2] ?? "";
  const app = appsByName.get(appName);

  if (subPath === "" && req.method === "GET") {
    if (!app) return sendJson(res, 404, { error: "App not found" });
    return sendJson(res, 200, { name: app.name, status: app.status, organization: { slug: app.orgSlug } });
  }
  if (subPath === "" && req.method === "DELETE") {
    appsByName.delete(appName);
    return sendJson(res, 202, {});
  }
  if (!app) {
    return sendJson(res, 404, { error: "App not found" });
  }

  // Volumes. Real Fly answers a create with 201 (not 200) and rejects a shrink,
  // so the mock does both — those are exactly the behaviours Marshal codes against.
  if (subPath === "/volumes" && req.method === "GET") {
    return sendJson(res, 200, [...app.volumesById.values()]);
  }
  if (subPath === "/volumes" && req.method === "POST") {
    const body = JSON.parse(rawBody);
    const volume = {
      id: `vol_mock${String(++volumeCounter).padStart(10, "0")}`,
      name: body.name ?? `volume-${volumeCounter}`,
      state: "created",
      size_gb: body.size_gb ?? 1,
      region: body.region ?? "mock",
      attached_machine_id: null,
    };
    app.volumesById.set(volume.id, volume);
    appendLog(app, `Volume ${volume.name} created (${volume.size_gb}GB)`);
    return sendJson(res, 201, volume);
  }
  const volumeMatch = /^\/volumes\/([^/]+)(\/.*)?$/.exec(subPath);
  if (volumeMatch) {
    const volume = app.volumesById.get(volumeMatch[1]);
    const volumeSub = volumeMatch[2] ?? "";
    if (!volume) return sendJson(res, 404, { error: "Volume not found" });
    if (volumeSub === "" && req.method === "GET") {
      return sendJson(res, 200, volume);
    }
    if (volumeSub === "/extend" && req.method === "PUT") {
      const body = JSON.parse(rawBody);
      const sizeGb = body.size_gb ?? volume.size_gb;
      if (sizeGb <= volume.size_gb) {
        return sendJson(res, 400, { error: `Invalid volume size - Specified volume size must be greater than ${volume.size_gb}` });
      }
      volume.size_gb = sizeGb;
      appendLog(app, `Volume ${volume.name} extended to ${volume.size_gb}GB`);
      return sendJson(res, 200, { volume });
    }
  }

  if (subPath === "/machines" && req.method === "GET") {
    return sendJson(res, 200, [...app.machinesById.values()].map(machineJson));
  }
  if (subPath === "/machines" && req.method === "POST") {
    const body = JSON.parse(rawBody);
    // A volume attaches to at most one machine — real Fly answers a second
    // claim with 412 (smoke-verified). Mirrored so a bug that tries to build a
    // volume-backed fleet fails here instead of only in production.
    const claim = claimVolumesOrError(app, body.config, null);
    if (claim) return sendJson(res, 412, claim);
    const machine = {
      id: `mock${String(++machineCounter).padStart(10, "0")}`,
      name: body.name ?? `machine-${machineCounter}`,
      state: "started",
      region: body.region ?? "mock",
      instanceId: `inst-${machineCounter}-1`,
      config: body.config ?? {},
      updates: 1,
    };
    attachVolumes(app, machine);
    app.machinesById.set(machine.id, machine);
    appendLog(app, `Machine created with image ${machine.config.image ?? "unknown"}`, { instance: machine.id });
    appendLog(app, `Machine started`, { instance: machine.id });
    appendLog(app, `mock app listening`, { instance: machine.id, provider: "app" });
    return sendJson(res, 200, machineJson(machine));
  }

  const machineMatch = /^\/machines\/([^/]+)(\/.*)?$/.exec(subPath);
  if (machineMatch) {
    const machine = app.machinesById.get(machineMatch[1]);
    const machineSub = machineMatch[2] ?? "";
    if (!machine) return sendJson(res, 404, { error: "Machine not found" });
    if (machineSub === "" && req.method === "GET") {
      return sendJson(res, 200, machineJson(machine));
    }
    if (machineSub === "" && req.method === "POST") {
      const body = JSON.parse(rawBody);
      // A machine's MOUNT SET cannot be changed in place. Fly places a machine on its
      // volume's host, so an already-placed machine cannot adopt a volume created
      // afterwards — real Fly answers `400 invalid_argument: volume does not exist`
      // even once the volume is listed and `created` (verified against real Fly).
      // Reproduced here so the callers' destroy-and-recreate path is exercised by CI
      // instead of only discovered in production.
      const before = mountedVolumeIds(machine.config).slice().sort().join(",");
      const after = mountedVolumeIds(body.config).slice().sort().join(",");
      if (before !== after) {
        return sendJson(res, 400, { error: "invalid_argument: volume does not exist" });
      }
      // Re-claiming the volume this machine already holds is fine (that is what
      // every re-apply does); claiming one held by another machine is not.
      const claim = claimVolumesOrError(app, body.config, machine.id);
      if (claim) return sendJson(res, 412, claim);
      detachVolumes(app, machine.id);
      machine.config = body.config ?? machine.config;
      attachVolumes(app, machine);
      machine.state = "started";
      machine.instanceId = `inst-${machine.id}-${++machine.updates}`;
      appendLog(app, `Machine updated to image ${machine.config.image ?? "unknown"}`, { instance: machine.id });
      return sendJson(res, 200, machineJson(machine));
    }
    if (machineSub === "" && req.method === "DELETE") {
      // The volume OUTLIVES the machine and becomes unattached (smoke-verified);
      // only destroying the app takes volumes with it.
      detachVolumes(app, machine.id);
      app.machinesById.delete(machine.id);
      appendLog(app, `Machine destroyed`, { instance: machine.id });
      return sendJson(res, 200, {});
    }
    if (machineSub === "/start" && req.method === "POST") {
      machine.state = "started";
      appendLog(app, `Machine started`, { instance: machine.id });
      return sendJson(res, 200, {});
    }
    if (machineSub === "/stop" && req.method === "POST") {
      machine.state = "stopped";
      appendLog(app, `Machine stopped`, { instance: machine.id });
      return sendJson(res, 200, {});
    }
    if (machineSub.startsWith("/wait") && req.method === "GET") {
      // Mirror the real /wait contract enough to catch regressions: timeout caps at 60s
      // (SMOKE-RESULTS deviation #5 — larger values 400), and a stale instance_id is a 400.
      const timeout = Number(url.searchParams.get("timeout") ?? "60");
      if (Number.isFinite(timeout) && timeout > 60) return sendJson(res, 400, { error: "timeout exceeds 60s" });
      const wantInstance = url.searchParams.get("instance_id");
      if (wantInstance !== null && wantInstance !== machine.instanceId) return sendJson(res, 400, { error: "instance_id mismatch" });
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: `mock: unhandled path ${req.method} ${path}` });
}

server.listen(8080, () => console.log("fly-mock listening on 8080"));
EOF

EXPOSE 8080

CMD ["node", "server.mjs"]
