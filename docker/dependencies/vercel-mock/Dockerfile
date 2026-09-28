FROM node:24-slim

# A minimal in-memory mock of the subset of the Vercel REST API used by the
# backend's Deployments app (apps/backend/src/lib/deployments/vercel-client.tsx).
# Used by e2e tests and local development so CI never talks to real Vercel.
#
# Deterministic behaviors tests rely on:
# - Deployments advance one state per GET poll: QUEUED -> BUILDING -> READY
#   (or -> ERROR when the build command contains the string "fail-this-build").
# - Domains ending in ".verified.test" verify immediately; all others stay
#   pending with a TXT challenge.
# - Deployment URLs are derived from the project name only (no counters), so
#   snapshot tests stay stable.
# - GET /__mock/projects/:idOrName/env-values exposes stored env var VALUES for
#   test assertions (the real Vercel API never returns encrypted values).

WORKDIR /app

RUN cat <<'EOF' > server.mjs
import http from "node:http";

const EXPECTED_TOKEN = "mock_hexclave_vercel_key";

let projectCounter = 0;
let deploymentCounter = 0;
let envCounter = 0;
const projectsById = new Map();
const deploymentsById = new Map();
const uploadedFileShas = new Set();

function findProject(idOrName) {
  if (projectsById.has(idOrName)) return projectsById.get(idOrName);
  for (const project of projectsById.values()) {
    if (project.name === idOrName) return project;
  }
  return undefined;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function domainJson(domain) {
  return {
    name: domain.name,
    apexName: domain.apexName,
    verified: domain.verified,
    verification: domain.verified ? undefined : [
      { type: "TXT", domain: `_vercel.${domain.apexName}`, value: `vc-domain-verify=${domain.name},mock0000`, reason: "pending_domain_verification" },
    ],
  };
}

function apexOf(hostname) {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
    return sendError(res, 403, "forbidden", "Invalid token in mock (expected the mock_hexclave_vercel_key token)");
  }

  let body = undefined;
  if ((req.headers["content-type"] ?? "").includes("application/json") && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      return sendError(res, 400, "bad_request", "Invalid JSON body");
    }
  }

  let match;

  // ---- files ----------------------------------------------------------------
  if (req.method === "POST" && path === "/v2/files") {
    const digest = req.headers["x-vercel-digest"];
    if (typeof digest !== "string" || !/^[0-9a-f]{40}$/.test(digest)) {
      return sendError(res, 400, "bad_request", "Missing or invalid x-vercel-digest header");
    }
    uploadedFileShas.add(digest);
    return sendJson(res, 200, {});
  }

  // ---- projects -------------------------------------------------------------
  if (req.method === "POST" && path === "/v10/projects") {
    if (typeof body?.name !== "string" || body.name === "") {
      return sendError(res, 400, "bad_request", "Missing project name");
    }
    if (findProject(body.name) != null) {
      return sendError(res, 409, "conflict", `Project ${body.name} already exists`);
    }
    const project = {
      id: `prj_mock${++projectCounter}`,
      name: body.name,
      framework: body.framework ?? null,
      envVars: new Map(),
      domains: new Map(),
    };
    projectsById.set(project.id, project);
    return sendJson(res, 200, { id: project.id, name: project.name, framework: project.framework });
  }

  if ((match = path.match(/^\/v9\/projects\/([^/]+)$/)) != null) {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    if (req.method === "GET") {
      return sendJson(res, 200, { id: project.id, name: project.name, framework: project.framework });
    }
    if (req.method === "PATCH") {
      // Used by the backend to disable deployment protection at provisioning.
      if (body != null && "ssoProtection" in body) {
        project.ssoProtection = body.ssoProtection;
      }
      return sendJson(res, 200, { id: project.id, name: project.name, framework: project.framework, ssoProtection: project.ssoProtection ?? null });
    }
    if (req.method === "DELETE") {
      projectsById.delete(project.id);
      return sendJson(res, 204, {});
    }
  }

  // Domain DNS-configuration check: mirrors the real API's semantics where
  // "verified" (ownership) and "misconfigured" (DNS records) are independent.
  // The mock treats *.verified.test as fully configured, everything else as
  // misconfigured.
  if ((match = path.match(/^\/v6\/domains\/([^/]+)\/config$/)) != null && req.method === "GET") {
    const hostname = decodeURIComponent(match[1]).toLowerCase();
    return sendJson(res, 200, { misconfigured: !hostname.endsWith(".verified.test") });
  }

  // ---- env vars -------------------------------------------------------------
  if ((match = path.match(/^\/v10\/projects\/([^/]+)\/env$/)) != null && req.method === "POST") {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    const inputs = Array.isArray(body) ? body : [body];
    for (const input of inputs) {
      if (typeof input?.key !== "string" || typeof input?.value !== "string") {
        return sendError(res, 400, "bad_request", "Env var entries must have key and value");
      }
      if (input.type !== "encrypted") {
        return sendError(res, 400, "bad_request", "Mock only accepts encrypted env vars (like the backend must send)");
      }
      const existing = [...project.envVars.values()].find((envVar) => envVar.key === input.key);
      if (existing != null && url.searchParams.get("upsert") !== "true") {
        return sendError(res, 400, "env_conflict", `Env var ${input.key} already exists and upsert is not set`);
      }
      const id = existing?.id ?? `env_mock${++envCounter}`;
      project.envVars.set(id, { id, key: input.key, value: input.value, type: input.type, target: input.target ?? [] });
    }
    return sendJson(res, 201, { created: inputs.length });
  }

  if ((match = path.match(/^\/v9\/projects\/([^/]+)\/env$/)) != null && req.method === "GET") {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    return sendJson(res, 200, { envs: [...project.envVars.values()].map(({ id, key }) => ({ id, key, type: "encrypted" })) });
  }

  if ((match = path.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/)) != null && req.method === "DELETE") {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    if (!project.envVars.delete(decodeURIComponent(match[2]))) {
      return sendError(res, 404, "not_found", "Env var not found");
    }
    return sendJson(res, 200, {});
  }

  // Mock-only introspection: exposes stored env var VALUES so e2e tests can
  // assert server-side reference resolution and encryption-type handling.
  if ((match = path.match(/^\/__mock\/projects\/([^/]+)\/env-values$/)) != null && req.method === "GET") {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    const values = {};
    for (const envVar of project.envVars.values()) values[envVar.key] = envVar.value;
    return sendJson(res, 200, { values });
  }

  // ---- domains --------------------------------------------------------------
  if ((match = path.match(/^\/v10\/projects\/([^/]+)\/domains$/)) != null && req.method === "POST") {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    if (typeof body?.name !== "string" || !body.name.includes(".")) {
      return sendError(res, 400, "invalid_domain", "Invalid domain name");
    }
    const hostname = body.name.toLowerCase();
    if (project.domains.has(hostname)) {
      return sendError(res, 409, "domain_already_exists", `Domain ${hostname} already added to this project`);
    }
    const domain = { name: hostname, apexName: apexOf(hostname), verified: hostname.endsWith(".verified.test") };
    project.domains.set(hostname, domain);
    return sendJson(res, 200, domainJson(domain));
  }

  if ((match = path.match(/^\/v9\/projects\/([^/]+)\/domains\/([^/]+)\/verify$/)) != null && req.method === "POST") {
    const project = findProject(decodeURIComponent(match[1]));
    const domain = project?.domains.get(decodeURIComponent(match[2]).toLowerCase());
    if (domain == null) return sendError(res, 404, "not_found", "Domain not found");
    // Like the real API: verify answers 400 when the ownership challenge isn't
    // satisfied. Hostnames ending in .txt-challenge.test exercise this path.
    if (domain.name.endsWith(".txt-challenge.test")) {
      return sendError(res, 400, "missing_txt_record", `Domain _vercel.${domain.apexName} is missing required TXT Record "vc-domain-verify=${domain.name},mock0000"`);
    }
    domain.verified = domain.verified || domain.name.endsWith(".verified.test");
    return sendJson(res, 200, domainJson(domain));
  }

  if ((match = path.match(/^\/v9\/projects\/([^/]+)\/domains\/([^/]+)$/)) != null) {
    const project = findProject(decodeURIComponent(match[1]));
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    const hostname = decodeURIComponent(match[2]).toLowerCase();
    const domain = project.domains.get(hostname);
    if (req.method === "GET") {
      if (domain == null) return sendError(res, 404, "not_found", "Domain not found");
      return sendJson(res, 200, domainJson(domain));
    }
    if (req.method === "DELETE") {
      if (!project.domains.delete(hostname)) return sendError(res, 404, "not_found", "Domain not found");
      return sendJson(res, 200, {});
    }
  }

  // ---- deployments ----------------------------------------------------------
  if (req.method === "POST" && path === "/v13/deployments") {
    const project = body?.project != null ? findProject(body.project) : findProject(body?.name);
    if (project == null) return sendError(res, 404, "not_found", "Project not found");
    const files = Array.isArray(body?.files) ? body.files : [];
    if (files.length === 0) {
      return sendError(res, 400, "bad_request", "Deployment must include files");
    }
    for (const file of files) {
      if (typeof file?.file !== "string" || typeof file?.sha !== "string") {
        return sendError(res, 400, "bad_request", "Deployment files must have file and sha");
      }
      if (!uploadedFileShas.has(file.sha)) {
        return sendError(res, 400, "missing_files", `File ${file.file} (sha ${file.sha}) was never uploaded`);
      }
    }
    const buildCommand = body?.projectSettings?.buildCommand ?? "";
    // Echo the project's env values into the build log, like a build script
    // printing its environment would. This is what lets e2e tests assert that
    // the backend redacts secret values from streamed logs.
    const envDump = [...project.envVars.values()].map((envVar) => `${envVar.key}=${envVar.value}`).join(" ");
    const deployment = {
      id: `dpl_mock${++deploymentCounter}`,
      projectId: project.id,
      target: body?.target ?? "production",
      readyState: "QUEUED",
      // No counter in the URL so snapshot tests stay stable across runs.
      url: `${project.name}.vercel-mock.localhost`,
      willFail: typeof buildCommand === "string" && buildCommand.includes("fail-this-build"),
      fileCount: files.length,
      pollCount: 0,
      events: [
        { type: "stdout", created: 1700000000000, payload: { text: `Cloning completed (${files.length} files)` } },
        { type: "stdout", created: 1700000000001, payload: { text: `Running build command: ${buildCommand || "(auto-detected)"}` } },
        ...(envDump === "" ? [] : [{ type: "stdout", created: 1700000000001, payload: { text: `Build environment: ${envDump}` } }]),
      ],
    };
    deploymentsById.set(deployment.id, deployment);
    return sendJson(res, 200, { id: deployment.id, readyState: deployment.readyState, url: deployment.url });
  }

  if ((match = path.match(/^\/v13\/deployments\/([^/]+)$/)) != null && req.method === "GET") {
    const deployment = deploymentsById.get(decodeURIComponent(match[1]));
    if (deployment == null) return sendError(res, 404, "not_found", "Deployment not found");
    // Advance one state per poll so tests are deterministic.
    deployment.pollCount++;
    if (deployment.readyState === "QUEUED") {
      deployment.readyState = "BUILDING";
      deployment.events.push({ type: "stdout", created: 1700000000002, payload: { text: "Build started" } });
    } else if (deployment.readyState === "BUILDING") {
      if (deployment.willFail) {
        deployment.readyState = "ERROR";
        deployment.errorMessage = "Build failed with exit code 1";
        deployment.events.push({ type: "stderr", created: 1700000000003, payload: { text: "Error: build command failed" } });
      } else {
        deployment.readyState = "READY";
        deployment.events.push({ type: "stdout", created: 1700000000003, payload: { text: "Build completed. Deployment ready." } });
      }
    }
    return sendJson(res, 200, {
      id: deployment.id,
      readyState: deployment.readyState,
      url: deployment.url,
      errorMessage: deployment.errorMessage ?? null,
    });
  }

  if ((match = path.match(/^\/v3\/deployments\/([^/]+)\/events$/)) != null && req.method === "GET") {
    const deployment = deploymentsById.get(decodeURIComponent(match[1]));
    if (deployment == null) return sendError(res, 404, "not_found", "Deployment not found");
    return sendJson(res, 200, deployment.events);
  }

  return sendError(res, 404, "not_found", `Mock has no handler for ${req.method} ${path}`);
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`vercel-mock listening on :${port}`);
});
EOF

EXPOSE 8080

CMD ["node", "server.mjs"]
