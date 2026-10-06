import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

const RELEASE = "1.4.2";
const PROJECT_ID = "internal";
const ENVIRONMENT = "development";
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type SeedSourceMapReleaseOptions = {
  apiUrl: URL,
  cliEntryPath: string,
  fixtureDirectory: string,
  secretServerKey: string,
  runCli?: (input: { executable: string, args: readonly string[], env: NodeJS.ProcessEnv }) => Promise<string>,
  fetchImpl?: typeof fetch,
  wait?: (milliseconds: number) => Promise<void>,
};

export function backendUrlForPortPrefix(prefix: string): URL {
  if (!/^[0-9]{1,3}$/u.test(prefix)) throw new Error("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX must contain one to three digits");
  const port = Number(`${prefix}02`);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX produces an invalid backend port");
  return new URL(`http://localhost:${port}`);
}

export async function seedSourceMapRelease(options: SeedSourceMapReleaseOptions): Promise<void> {
  if (options.secretServerKey === "") throw new Error("Source-map seed requires the internal project secret server key");
  const runCli = options.runCli ?? runCliProcess;
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? waitForDuration;
  const headers = {
    "x-stack-access-type": "server",
    "x-stack-project-id": PROJECT_ID,
    "x-stack-secret-server-key": options.secretServerKey,
  };
  await waitForBackend(options.apiUrl, headers, fetchImpl, wait);

  const temporaryDirectory = path.join(tmpdir(), `hexclave-source-map-${randomUUID()}.untracked`);
  await mkdir(temporaryDirectory, { recursive: false });
  try {
    await cp(options.fixtureDirectory, temporaryDirectory, { recursive: true });
    const args = [
      options.cliEntryPath,
      "sourcemaps",
      "upload",
      temporaryDirectory,
      "--release",
      RELEASE,
      "--environment",
      ENVIRONMENT,
      "--cloud-project-id",
      PROJECT_ID,
    ];
    const output = await runCli({
      executable: process.execPath,
      args,
      env: {
        HEXCLAVE_API_URL: options.apiUrl.toString(),
        HEXCLAVE_PROJECT_ID: PROJECT_ID,
        HEXCLAVE_SECRET_SERVER_KEY: options.secretServerKey,
        NODE_ENV: "development",
      },
    });
    const published = parseCliPublication(output);
    const detailResponse = await fetchImpl(new URL(`/api/latest/releases?version=${encodeURIComponent(RELEASE)}`, options.apiUrl), { headers });
    if (!detailResponse.ok) throw new Error(`Source-map seed could not read release ${RELEASE} after upload. HTTP ${detailResponse.status}`);
    const detail = await detailResponse.json();
    if (!catalogContainsManifest(detail, published.manifestSha256)) {
      throw new Error(`Source-map seed uploaded release ${RELEASE}, but the release catalog did not contain its manifest`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function seedLocalSourceMapReleaseFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(moduleDirectory, "../../..");
  const secretServerKey = env.HEXCLAVE_INTERNAL_PROJECT_SECRET_SERVER_KEY
    ?? env.STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY;
  if (secretServerKey === undefined || secretServerKey === "") {
    throw new Error("Source-map seed requires HEXCLAVE_INTERNAL_PROJECT_SECRET_SERVER_KEY");
  }
  await seedSourceMapRelease({
    apiUrl: backendUrlForPortPrefix(env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81"),
    cliEntryPath: path.join(repositoryRoot, "packages/cli/dist/index.js"),
    fixtureDirectory: path.join(repositoryRoot, "packages/cli/src/lib/__fixtures__"),
    secretServerKey,
  });
}

function runCliProcess(input: { executable: string, args: readonly string[], env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(input.executable, [...input.args], { env: input.env, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Source-map seed CLI failed with exit code ${error.code ?? "unknown"}. ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function waitForBackend(
  apiUrl: URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const url = new URL("/api/latest/releases/recent?limit=1", apiUrl);
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetchImpl(url, { headers }).then((result) => result, () => null);
    if (response?.ok === true) return;
    await wait(250);
  }
  throw new Error(`Source-map seed could not reach the authenticated release API at ${url.origin}`);
}

function waitForDuration(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseCliPublication(output: string): { manifestSha256: string } {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)
    || parsed.release !== RELEASE
    || typeof parsed.manifestSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(parsed.manifestSha256)
    || (parsed.catalogStatus !== "published" && parsed.catalogStatus !== "already_published")) {
    throw new Error("Source-map seed CLI returned an invalid publication result");
  }
  return { manifestSha256: parsed.manifestSha256 };
}

function catalogContainsManifest(value: unknown, manifestSha256: string): boolean {
  if (!isRecord(value) || !isRecord(value.artifacts) || !Array.isArray(value.artifacts.items)) return false;
  return value.artifacts.items.some((item) => isRecord(item) && item.manifest_sha256 === manifestSha256);
}
