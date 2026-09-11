// SPIKE: Depot (depot.dev) as a remote BuildKit daemon for Dockerfile builds.
//
// Depot's API is Connect-RPC (JSON over HTTP). One Depot project per namespace
// (its cache is per project, which is what keeps tenants apart); one Depot
// build per deployment, whose BuildKit endpoint the harness machine points
// buildctl at instead of a local buildkitd.

const DEPOT_API = "https://api.depot.dev";

type DepotEndpoint = {
  buildId: string,
  buildToken: string,
  endpoint: string,
  serverName: string,
  clientCert: string,
  clientKey: string,
  caCert: string,
};

async function rpc<T>(token: string, service: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${DEPOT_API}/${service}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`depot ${service}/${method} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export function depotToken(): string | null {
  const token = process.env.MARSHAL_DEPOT_TOKEN ?? process.env.DEPOT_API_KEY;
  return token === undefined || token === "" ? null : token;
}

/** The Depot project for a namespace, created on first use. */
export async function ensureDepotProject(token: string, name: string): Promise<string> {
  const list = await rpc<{ projects?: { projectId: string, name: string }[] }>(token, "depot.core.v1.ProjectService", "ListProjects", {});
  const existing = (list.projects ?? []).find((project) => project.name === name);
  if (existing !== undefined) return existing.projectId;
  const created = await rpc<{ project: { projectId: string } }>(token, "depot.core.v1.ProjectService", "CreateProject", {
    name,
    regionId: "us-east-1",
    cachePolicy: { keepBytes: "53687091200", keepDays: 14 },
  });
  return created.project.projectId;
}

type ActiveConnection = { endpoint: string, serverName: string, cert?: { cert?: { cert: string }, key?: { key: string } }, caCert?: { cert: string } };

// GetEndpoint is SERVER-STREAMING (it emits `pending` until the builder is up, then
// `active`), so it speaks Connect's enveloped framing: each message is a 1-byte flag +
// 4-byte big-endian length + payload, and the final envelope (flag 0x02) carries the
// end-of-stream trailer, which is where an error would be.
async function streamEndpoint(buildToken: string, buildId: string, timeoutMs: number): Promise<ActiveConnection> {
  const payload = Buffer.from(JSON.stringify({ buildId, platform: "PLATFORM_AMD64" }), "utf8");
  const body = Buffer.concat([Buffer.from([0, (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff]), payload]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${DEPOT_API}/depot.buildkit.v1.BuildKitService/GetEndpoint`, {
      method: "POST",
      headers: { Authorization: `Bearer ${buildToken}`, "Content-Type": "application/connect+json", "Connect-Protocol-Version": "1" },
      body,
      signal: controller.signal,
    });
    if (!res.ok || res.body === null) throw new Error(`depot GetEndpoint -> ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    let buffered = Buffer.alloc(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered = Buffer.concat([buffered, Buffer.from(value)]);
      while (buffered.length >= 5) {
        const flags = buffered[0];
        const length = buffered.readUInt32BE(1);
        if (buffered.length < 5 + length) break;
        const message = buffered.subarray(5, 5 + length).toString("utf8");
        buffered = buffered.subarray(5 + length);
        if (flags & 0x02) {
          throw new Error(`depot GetEndpoint ended before the endpoint became active: ${message}`);
        }
        const parsed = JSON.parse(message) as { active?: ActiveConnection, pending?: Record<string, never> };
        if (parsed.active !== undefined) {
          await reader.cancel();
          return parsed.active;
        }
      }
    }
    throw new Error("depot GetEndpoint stream closed without an active endpoint");
  } finally {
    clearTimeout(timer);
  }
}

export type DepotBuild = { buildId: string, buildToken: string };

/** Registers a build with Depot; its endpoint is acquired separately. */
export async function createDepotBuild(token: string, projectId: string): Promise<DepotBuild> {
  return await rpc<DepotBuild>(token, "depot.build.v1.BuildService", "CreateBuild", { projectId });
}

/** Waits for a build's amd64 BuildKit endpoint to become active. */
export async function acquireDepotEndpoint(build: DepotBuild, timeoutMs = 3 * 60 * 1000): Promise<DepotEndpoint> {
  const active = await streamEndpoint(build.buildToken, build.buildId, timeoutMs);
  const clientCert = active.cert?.cert?.cert;
  const clientKey = active.cert?.key?.key;
  const caCert = active.caCert?.cert;
  if (clientCert === undefined || clientKey === undefined || caCert === undefined) {
    throw new Error(`depot GetEndpoint returned an active connection without a full certificate set: ${JSON.stringify(Object.keys(active))}`);
  }
  return { buildId: build.buildId, buildToken: build.buildToken, endpoint: active.endpoint, serverName: active.serverName, clientCert, clientKey, caCert };
}

/** Tells Depot the build is over so its endpoint is reclaimed now rather than on timeout. */
export async function releaseDepotEndpoint(endpoint: DepotBuild): Promise<void> {
  await rpc(endpoint.buildToken, "depot.buildkit.v1.BuildKitService", "ReleaseEndpoint", { buildId: endpoint.buildId, platform: "PLATFORM_AMD64" });
}

/**
 * The handoff the harness sources: a shell fragment with the endpoint and the
 * PEMs base64-encoded, so /bin/sh needs nothing but `base64 -d` to use them.
 * Every value is either a URL/hostname Depot minted or base64, so nothing here
 * can break out of the assignments.
 */
export function renderDepotHandoff(endpoint: DepotEndpoint): string {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  return [
    `BUILDKIT_ADDR=${JSON.stringify(endpoint.endpoint)}`,
    `BUILDKIT_TLS_SERVER_NAME=${JSON.stringify(endpoint.serverName)}`,
    `BUILDKIT_TLS_CA_B64=${b64(endpoint.caCert)}`,
    `BUILDKIT_TLS_CERT_B64=${b64(endpoint.clientCert)}`,
    `BUILDKIT_TLS_KEY_B64=${b64(endpoint.clientKey)}`,
    "",
  ].join("\n");
}
