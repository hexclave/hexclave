import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareObservabilityLab } from "./observability-lab-upload";
import { buildObservabilityDemoBundle } from "./symbolicated-bundle";
import {
  OBSERVABILITY_DEMO_ENVIRONMENT,
  OBSERVABILITY_DEMO_RELEASE,
} from "../../observability-lab-contract";

const AUTH = {
  apiUrl: "http://api.test",
  projectId: "internal",
  secretServerKey: "ssk_test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareObservabilityLab", () => {
  it("upserts the release, uploads the bundle and map, then finalizes", async () => {
    const bundle = buildObservabilityDemoBundle({
      projectId: AUTH.projectId,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/latest/releases") && init?.method === "POST") {
        return jsonResponse({ id: "11111111-1111-4111-8111-111111111111", version: OBSERVABILITY_DEMO_RELEASE });
      }
      if (url.endsWith("/api/latest/releases/commits")) {
        return jsonResponse({ id: "commit-1" });
      }
      if (url.endsWith("/api/latest/releases/deployments")) {
        return jsonResponse({ id: "deploy-1" });
      }
      if (url.endsWith("/api/latest/source-maps/artifacts") && !url.endsWith("/finalize")) {
        return jsonResponse({
          manifest_sha256: bundle.manifestSha256,
          artifacts: [{
            debug_id: bundle.debugId,
            already_finalized: false,
            bundle_upload_url: "http://uploads.test/bundle",
            source_map_upload_url: "http://uploads.test/map",
          }],
        });
      }
      if (url === "http://uploads.test/bundle" || url === "http://uploads.test/map") {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/api/latest/source-maps/artifacts/finalize")) {
        return jsonResponse({ already_uploaded: [], uploaded: [bundle.debugId] });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareObservabilityLab(AUTH)).resolves.toEqual({
      release: OBSERVABILITY_DEMO_RELEASE,
      releaseId: "11111111-1111-4111-8111-111111111111",
      debugId: bundle.debugId,
      codeFile: bundle.manifest.artifacts[0].codeFile,
      manifestSha256: bundle.manifestSha256,
      sourceMaps: "uploaded",
    });

    const registrationCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/api/latest/source-maps/artifacts"));
    expect(registrationCall?.[1]?.headers).toMatchObject({
      "x-stack-access-type": "server",
      "x-stack-project-id": "internal",
      "x-stack-secret-server-key": "ssk_test",
    });
    const putUrls = fetchMock.mock.calls
      .filter((call) => call[1]?.method === "PUT")
      .map((call) => String(call[0]));
    expect(putUrls).toEqual(["http://uploads.test/bundle", "http://uploads.test/map"]);
  });

  it("skips object uploads when the artifact is already finalized", async () => {
    const bundle = buildObservabilityDemoBundle({
      projectId: AUTH.projectId,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/latest/releases") && init?.method === "POST") {
        return jsonResponse({ id: "11111111-1111-4111-8111-111111111111", version: OBSERVABILITY_DEMO_RELEASE });
      }
      if (url.endsWith("/api/latest/releases/commits") || url.endsWith("/api/latest/releases/deployments")) {
        return jsonResponse({ id: "ok" });
      }
      if (url.endsWith("/api/latest/source-maps/artifacts") && !url.endsWith("/finalize")) {
        return jsonResponse({
          artifacts: [{
            debug_id: bundle.debugId,
            already_finalized: true,
            bundle_upload_url: "http://uploads.test/bundle",
            source_map_upload_url: "http://uploads.test/map",
          }],
        });
      }
      if (url.endsWith("/api/latest/source-maps/artifacts/finalize")) {
        return jsonResponse({ already_uploaded: [bundle.debugId], uploaded: [] });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareObservabilityLab(AUTH)).resolves.toMatchObject({ sourceMaps: "already_uploaded" });
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
