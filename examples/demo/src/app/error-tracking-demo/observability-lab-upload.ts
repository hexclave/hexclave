import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  buildObservabilityDemoBundle,
  type ObservabilityDemoArtifactManifest,
  type ObservabilityDemoBundle,
} from "./symbolicated-bundle";
import {
  OBSERVABILITY_DEMO_ENVIRONMENT,
  OBSERVABILITY_DEMO_RELEASE,
} from "../../observability-lab-contract";

const SOURCE_MAP_REGISTRATION_PATH = "/api/latest/source-maps/artifacts";
const SOURCE_MAP_FINALIZE_PATH = "/api/latest/source-maps/artifacts/finalize";
const RELEASES_PATH = "/api/latest/releases";
const RELEASE_COMMITS_PATH = "/api/latest/releases/commits";
const RELEASE_DEPLOYMENTS_PATH = "/api/latest/releases/deployments";

export type ObservabilityLabPrepareResult = {
  release: string,
  releaseId: string,
  debugId: string,
  codeFile: string,
  manifestSha256: string,
  sourceMaps: "uploaded" | "already_uploaded",
};

export type ObservabilityLabApiAuth = {
  apiUrl: string,
  projectId: string,
  secretServerKey: string,
};

export async function prepareObservabilityLab(auth: ObservabilityLabApiAuth): Promise<ObservabilityLabPrepareResult> {
  const bundle = buildObservabilityDemoBundle({
    projectId: auth.projectId,
    release: OBSERVABILITY_DEMO_RELEASE,
    environment: OBSERVABILITY_DEMO_ENVIRONMENT,
  });
  const release = await upsertDemoRelease(auth, bundle);
  const sourceMaps = await uploadDemoSourceMaps(auth, bundle);
  return {
    release: OBSERVABILITY_DEMO_RELEASE,
    releaseId: release.id,
    debugId: bundle.debugId,
    codeFile: bundle.manifest.artifacts[0].codeFile,
    manifestSha256: bundle.manifestSha256,
    sourceMaps,
  };
}

async function upsertDemoRelease(
  auth: ObservabilityLabApiAuth,
  bundle: ObservabilityDemoBundle,
): Promise<{ id: string }> {
  const releaseId = await requestJson(auth, RELEASES_PATH, {
    version: OBSERVABILITY_DEMO_RELEASE,
    status: "open",
    ref: "observability-demo",
    date_released: "2026-08-12T00:00:00.000Z",
  }, "release upsert", (value) => readString(readRecord(value, "release upsert"), "id", "release upsert"));
  const commitSha = bundle.manifestSha256.slice(0, 40);
  await requestJson(auth, RELEASE_COMMITS_PATH, {
    release_id: releaseId,
    repository: "hexclave/example-demo",
    commit_sha: commitSha,
    position: 0,
    message: "Register the observability lab source-map fixture.",
    author_name: "Observability Lab",
  }, "release commit", () => undefined);
  await requestJson(auth, RELEASE_DEPLOYMENTS_PATH, {
    release_id: releaseId,
    deployment_key: "observability-lab-local",
    environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    name: "local demo",
  }, "release deployment", () => undefined);
  return { id: releaseId };
}

async function uploadDemoSourceMaps(
  auth: ObservabilityLabApiAuth,
  bundle: ObservabilityDemoBundle,
): Promise<"uploaded" | "already_uploaded"> {
  const registeredArtifact = await requestJson(auth, SOURCE_MAP_REGISTRATION_PATH, {
    manifest: bundle.manifest,
    manifest_sha256: bundle.manifestSha256,
  }, "source-map registration", parseRegistrationArtifact, bundle.manifestSha256);
  if (!registeredArtifact.alreadyFinalized) {
    await putPresigned(registeredArtifact.bundleUploadUrl, "application/javascript", null, bundle.bundleBytes, "bundle upload");
    await putPresigned(registeredArtifact.sourceMapUploadUrl, "application/json", "gzip", bundle.sourceMapGzipped, "source-map upload");
  }
  const alreadyUploaded = await requestJson(auth, SOURCE_MAP_FINALIZE_PATH, {
    manifest_sha256: bundle.manifestSha256,
  }, "source-map finalize", (value) => readStringArray(readRecord(value, "source-map finalize"), "already_uploaded", "source-map finalize"), bundle.manifestSha256);
  if (alreadyUploaded.includes(bundle.debugId)) return "already_uploaded";
  return "uploaded";
}

type DemoRegisteredArtifact =
  | { alreadyFinalized: true }
  | { alreadyFinalized: false, bundleUploadUrl: string, sourceMapUploadUrl: string };

function parseRegistrationArtifact(value: unknown): DemoRegisteredArtifact {
  const artifacts = readArray(readRecord(value, "source-map registration"), "artifacts", "source-map registration");
  if (artifacts.length === 0) {
    throw new Error("Source-map registration returned no artifacts.");
  }
  const first = artifacts[0];
  const alreadyFinalized = readBoolean(first, "already_finalized", "source-map registration artifact");
  if (alreadyFinalized) return { alreadyFinalized: true };
  return {
    alreadyFinalized: false,
    bundleUploadUrl: readString(first, "bundle_upload_url", "source-map registration artifact"),
    sourceMapUploadUrl: readString(first, "source_map_upload_url", "source-map registration artifact"),
  };
}

type DemoApiRequestBody = Record<string, string | number | ObservabilityDemoArtifactManifest>;

async function requestJson<T>(
  auth: ObservabilityLabApiAuth,
  apiPath: string,
  body: DemoApiRequestBody,
  operation: string,
  parse: (value: unknown) => T,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-stack-access-type": "server",
    "x-stack-project-id": auth.projectId,
    "x-stack-secret-server-key": auth.secretServerKey,
  };
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${auth.apiUrl.replace(/\/+$/, "")}${apiPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} failed with status ${response.status}: ${describeBody(text, response.statusText)}`);
  }
  if (text.trim() === "") {
    throw new Error(`${operation} returned an empty response.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned a non-JSON response.`);
  }
  return parse(parsed);
}

async function putPresigned(
  url: string,
  contentType: string,
  contentEncoding: "gzip" | null,
  bytes: Uint8Array,
  operation: string,
): Promise<void> {
  const fetchBody = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  fetchBody.set(bytes);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": bytes.byteLength.toString(),
  };
  if (contentEncoding !== null) headers["content-encoding"] = contentEncoding;
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: fetchBody,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${operation} failed with status ${response.status}: ${describeBody(text, response.statusText)}`);
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function readArray(record: Record<string, unknown>, key: string, label: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${key} must be an array.`);
  }
  return value.map((item, index) => readRecord(item, `${label} ${key}[${index}]`));
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} ${key} must be a non-empty string.`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${label} ${key} must be a boolean.`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${key} must be an array of strings.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label} ${key} must be an array of strings.`);
    }
    strings.push(item);
  }
  return strings;
}

function describeBody(text: string, statusText: string): string {
  if (text.trim() === "") return statusText || "empty response";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return error.slice(0, 1_000);
      if (isRecord(error)) {
        const message = error.message;
        if (typeof message === "string") return message.slice(0, 1_000);
      }
      const message = parsed.message;
      if (typeof message === "string") return message.slice(0, 1_000);
    }
  } catch {
  }
  return text.trim().slice(0, 1_000);
}
