import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "dotenv";
import { flyConfig, getConfig, MOCK_FLY_TOKEN } from "./config.js";
import { FlyClient } from "./fly/client.js";
import { appNameForService } from "./fly/naming.js";
import { platformHostname } from "./platform-domain-names.js";
import { applyServiceSpec, deleteService, getServiceState } from "./services.js";
import { readSpec } from "./store.js";
import type { ServiceSpec } from "./types.js";

const ENV_ID = "domain-live-test";
const KEY = "web";
const MINUTE = 60_000;
const IMAGE = "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de";

export type LiveDomainRun = { version: 1, id: string, encryptionKey: string, scopeHash: string };
export type LiveDomainResult = { kind: "passed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadLiveCredentials(): Promise<Record<string, string | undefined>> {
  return parse(await readFile(new URL("../.env.local", import.meta.url), "utf8"));
}

function required(values: Record<string, string | undefined>, primary: string, alias: string): string {
  const value = values[primary] ?? values[alias];
  if (value === undefined || value.trim() === "") throw new Error(`apps/marshal/.env.local must define ${primary} (or ${alias})`);
  return value;
}

export function liveCredentialSettings(values: Record<string, string | undefined>) {
  const settings = {
    MARSHAL_FLY_API_TOKEN: required(values, "MARSHAL_FLY_API_TOKEN", "FLY_API_TOKEN"),
    MARSHAL_FLY_ORG_SLUG: required(values, "MARSHAL_FLY_ORG_SLUG", "FLY_ORG_SLUG"),
    MARSHAL_S3_ACCESS_KEY_ID: required(values, "MARSHAL_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID"),
    MARSHAL_S3_SECRET_ACCESS_KEY: required(values, "MARSHAL_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY"),
    MARSHAL_S3_ENDPOINT: required(values, "MARSHAL_S3_ENDPOINT", "S3_API_ENDPOINT"),
    MARSHAL_S3_BUCKET: required(values, "MARSHAL_S3_BUCKET", "S3_BUCKET_NAME"),
    MARSHAL_S3_REGION: values.MARSHAL_S3_REGION ?? "auto",
    MARSHAL_S3_FORCE_PATH_STYLE: values.MARSHAL_S3_FORCE_PATH_STYLE ?? "0",
    MARSHAL_FLY_REGION: values.MARSHAL_FLY_REGION ?? "iad",
  };
  assert.notEqual(settings.MARSHAL_FLY_API_TOKEN, MOCK_FLY_TOKEN, "The live test requires real Fly credentials");
  const endpoint = new URL(settings.MARSHAL_S3_ENDPOINT);
  assert.equal(endpoint.protocol, "https:", "The live test requires an HTTPS S3 endpoint");
  assert(endpoint.username === "" && endpoint.password === "", "S3 endpoint credentials must be supplied separately");
  return settings;
}

function scopeHash(settings: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify([settings.MARSHAL_FLY_ORG_SLUG, settings.MARSHAL_S3_ENDPOINT, settings.MARSHAL_S3_BUCKET])).digest("hex");
}

export function newLiveRun(settings: Record<string, string>): LiveDomainRun {
  return { version: 1, id: randomUUID(), encryptionKey: randomBytes(32).toString("hex"), scopeHash: scopeHash(settings) };
}

export function parseLiveRun(value: unknown, settings: Record<string, string>): LiveDomainRun {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.id)
    || typeof value.encryptionKey !== "string" || !/^[a-f0-9]{64}$/.test(value.encryptionKey) || value.scopeHash !== scopeHash(settings)) {
    throw new Error("Recovery file is invalid or belongs to a different Fly organization/S3 bucket");
  }
  return { version: 1, id: value.id, encryptionKey: value.encryptionKey, scopeHash: scopeHash(settings) };
}

export function configureLiveRun(settings: Record<string, string>, run: LiveDomainRun): void {
  // Never load the development env files: they can redirect real credentials to mocks.
  // No source build is exercised, so the unused builder is explicitly disabled by the
  // existing mock-builder setting. Fly, DNS, HTTPS, and the S3 store are all real.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("HEXCLAVE_MARSHAL_GCP_")) delete process.env[name];
  }
  Object.assign(process.env, settings, {
    MARSHAL_FLY_MACHINES_API_URL: "https://api.machines.dev",
    MARSHAL_FLY_GRAPHQL_API_URL: "https://api.fly.io/graphql",
    MARSHAL_FLY_LOGS_API_URL: "https://api.fly.io/api/v1",
    MARSHAL_FLY_REGISTRY_HOST: "registry.fly.io",
    MARSHAL_ENV_ID: ENV_ID,
    MARSHAL_API_KEY: randomBytes(32).toString("hex"),
    MARSHAL_BUILDER: "mock", MARSHAL_ALLOW_MOCKS: "1", MARSHAL_PUBLIC_URL: "",
    HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY: run.encryptionKey,
    HEXCLAVE_MARSHAL_S3_KEY_PREFIX: `live-domain-tests/${run.id}/`,
  });
}

export function liveRunIdentity(run: LiveDomainRun): { ns: string, app: string, hostname: string } {
  const ns = `domain-live-${run.id}`;
  return { ns, app: appNameForService(ENV_ID, ns, KEY), hostname: platformHostname(ENV_ID, ns, KEY) };
}

export async function saveRecoveryFile(run: LiveDomainRun): Promise<string> {
  const path = join(tmpdir(), `hexclave-domain-live-${run.id}.untracked.json`);
  // Only a disposable signing key and identity, never provider credentials. Exclusive
  // creation and mode 0600 also prevent overwriting another run's recovery information.
  await writeFile(path, JSON.stringify(run, null, 2), { flag: "wx", mode: 0o600 });
  return path;
}

function testSpec(marker: string): ServiceSpec {
  return {
    source: { image: IMAGE }, env: { HEXCLAVE_LIVE_TEST_MARKER: { value: marker } },
    config: {
      type: "serverless", public: true, min_instances: 1, max_instances: 1,
      ports: { "80": { protocol: "http" } },
      start_command: 'printf "%s" "$HEXCLAVE_LIVE_TEST_MARKER" > /usr/share/nginx/html/index.html && cp /usr/share/nginx/html/index.html /usr/share/nginx/html/llms.txt && exec nginx -g "daemon off;"',
    },
  };
}

export async function waitForLiveCheck(label: string, check: () => Promise<boolean>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const started = performance.now();
  for (;;) {
    signal.throwIfAborted();
    if (await check()) return;
    if (performance.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await delay(5000, undefined, { signal });
  }
}

async function servesMarker(url: string, marker: string): Promise<boolean> {
  try {
    // Standard fetch verifies TLS; redirects are refused so another origin cannot
    // accidentally satisfy the branded-hostname assertion.
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Cache-Control": "no-cache" } });
    const body = await response.text();
    return response.ok && body === marker;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) return false;
    throw error;
  }
}

export async function cleanupLiveRun(run: LiveDomainRun, recoveryPath: string): Promise<void> {
  const { ns, app } = liveRunIdentity(run);
  const fly = new FlyClient(flyConfig().token, flyConfig().orgSlug);
  for (const machine of await fly.listMachines(app)) {
    assert.equal(machine.config.metadata?.hexclave_ns, ns, "Refusing to delete a machine outside this live test");
    assert.equal(machine.config.metadata.hexclave_key, KEY, "Refusing to delete a different service");
  }
  console.log("Cleaning up the test Fly app and isolated service state...");
  await deleteService(ns, KEY);
  assert.equal(await fly.getApp(app), null, "Test Fly app was not removed");
  assert.equal(await readSpec(ns, KEY), null, "Test spec was not removed");
  await unlink(recoveryPath);
  console.log("Cleanup verified.");
}

export async function exerciseLiveRun(run: LiveDomainRun, signal: AbortSignal, timeoutMs: number): Promise<LiveDomainResult> {
  const { ns, app, hostname } = liveRunIdentity(run);
  const flyUrl = `https://${app}.fly.dev`;
  const brandedUrl = `https://${hostname}`;
  const marker = `hexclave-domain-live-${run.id}`;
  getConfig(); // Validate every setting before creating resources.
  console.log(`Fly app: ${app}\nBranded URL: ${brandedUrl}\nDeploying a disposable nginx service...`);
  const applied = await applyServiceSpec(ns, KEY, testSpec(marker), { runtime: "fly" });
  assert.equal(applied.state.error, null, "Test service failed to deploy");
  assert.equal(applied.state.outputs.url, brandedUrl, "A public service should immediately advertise its proxy URL");
  await waitForLiveCheck("the default Fly HTTPS URL", async () => await servesMarker(flyUrl, marker), signal, 3 * MINUTE);
  console.log("PASS: default Fly HTTPS serves this test's response.");

  await waitForLiveCheck("the branded HTTPS URL", async () => {
    return (await getServiceState(ns, KEY)).outputs.url === brandedUrl && await servesMarker(brandedUrl, marker);
  }, signal, timeoutMs);
  console.log("PASS: branded HTTPS proxies this test's response through hosted components.");
  // Hosted components has its own /llms.txt route. This catches proxy rules that
  // accidentally run after the framework/filesystem has already handled a path.
  await waitForLiveCheck("deployment routing ahead of hosted-component paths", async () => await servesMarker(`${brandedUrl}/llms.txt?probe=${run.id}`, marker), signal, timeoutMs);
  const head = await fetch(`${brandedUrl}/llms.txt`, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) });
  assert.equal(head.status, 200, "HEAD was not forwarded to the deployment");
  assert.equal(await head.text(), "", "HEAD unexpectedly returned a response body");
  const post = await fetch(`${brandedUrl}/llms.txt`, { method: "POST", body: "proxy-method-check", redirect: "error", signal: AbortSignal.timeout(10_000) });
  await post.text();
  assert.equal(post.status, 405, "nginx's static-file POST rejection was not preserved by the proxy");
  console.log("PASS: overlapping hosted paths, HEAD, and POST response status are forwarded.");

  const updatedMarker = `${marker}-redeployed`;
  const redeployed = await applyServiceSpec(ns, KEY, testSpec(updatedMarker), { runtime: "fly" });
  assert.equal(redeployed.state.error, null, "Redeployment failed");
  assert.equal(redeployed.state.outputs.url, brandedUrl, "Redeployment changed the platform URL");
  await waitForLiveCheck("the redeployed response", async () => await servesMarker(brandedUrl, updatedMarker) && await servesMarker(flyUrl, updatedMarker), signal, 3 * MINUTE);
  console.log("PASS: redeploy retained its hostname; both HTTPS URLs serve the new response.");
  return { kind: "passed" };
}
