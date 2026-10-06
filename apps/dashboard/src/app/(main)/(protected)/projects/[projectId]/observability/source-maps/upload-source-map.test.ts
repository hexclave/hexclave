import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDebugIdSnippet,
  deriveDebugId,
  normalizeArtifactPath,
  prepareSourceMapUpload,
  putPresignedArtifact,
} from "./upload-source-map";

const bundleSource = "console.log(1);";
const sourceMapSource = "{\"version\":3,\"sources\":[\"src.ts\"],\"names\":[],\"mappings\":\"AAAA\"}";

describe("browser source-map preparation", () => {
  it("derives a stable debug ID from the original bundle and map bytes", async () => {
    const encoder = new TextEncoder();

    await expect(deriveDebugId(encoder.encode(bundleSource), encoder.encode(sourceMapSource)))
      .resolves.toBe("fdecadcc-fcec-429d-868f-cb6db59cb599");
  });

  it("keeps the manifest's canonical key order and uploads injected bytes", async () => {
    const prepared = await prepareSourceMapUpload({
      projectId: "project-source-map-test",
      release: "2026.08.12",
      environment: "production",
      codeFile: "static/app.min.js",
      sourceMapFile: "static/app.min.js.map",
      bundleSource,
      sourceMapSource,
    });

    expect(Object.keys(prepared.manifest)).toEqual([
      "schemaVersion",
      "projectId",
      "release",
      "dist",
      "environment",
      "artifacts",
    ]);
    expect(Object.keys(prepared.manifest.artifacts[0])).toEqual([
      "debugId",
      "codeFile",
      "sourceMapFile",
      "sourceMapInline",
      "bundleSha256",
      "bundleBytes",
      "sourceMapSha256",
      "sourceMapBytes",
      "sourceMapGzippedBytes",
    ]);
    expect(prepared.bundleSource).toContain("// hexclave:debug-id-injection:start");
    expect(prepared.bundleSource).toContain(`//# debugId=${prepared.debugId}`);
    expect(prepared.sourceMapJson).toContain(`"debug_id":"${prepared.debugId}"`);
    expect(prepared.sourceMapJson).toContain(`"debugId":"${prepared.debugId}"`);
    expect(prepared.manifestJson).toBe(JSON.stringify(prepared.manifest));
    expect(prepared.bundleUploadBody.size).toBe(new TextEncoder().encode(prepared.bundleSource).byteLength);
    expect(prepared.sourceMapUploadBody.size).toBe(prepared.manifest.artifacts[0].sourceMapGzippedBytes);
  });

  it("inserts the runtime snippet before a trailing sourceMappingURL", () => {
    const debugId = "fdecadcc-fcec-429d-868f-cb6db59cb599";
    const injected = appendDebugIdSnippet(
      `${bundleSource}\n//# sourceMappingURL=app.min.js.map`,
      debugId,
    );

    expect(injected).toContain(`hexclave-dbid-${debugId}`);
    expect(injected.endsWith("//# sourceMappingURL=app.min.js.map")).toBe(true);
  });

  it("rejects only fully injected debug-ID identifiers, not the bare prefix literal", async () => {
    const prepare = (source: string) => prepareSourceMapUpload({
      projectId: "project-source-map-test",
      release: null,
      environment: null,
      codeFile: "static/app.min.js",
      sourceMapFile: "static/app.min.js.map",
      bundleSource: source,
      sourceMapSource,
    });

    await expect(prepare(`const prefix = "hexclave-dbid-";\n${bundleSource}`))
      .resolves.toMatchObject({ codeFile: "static/app.min.js" });
    await expect(prepare(`g._hexclaveDebugIdIdentifier="hexclave-dbid-fdecadcc-fcec-429d-868f-cb6db59cb599";\n${bundleSource}`))
      .rejects.toThrow("already contains a Hexclave debug ID");
    await expect(prepare(`// hexclave:debug-id-injection:start\n${bundleSource}`))
      .rejects.toThrow("already contains a Hexclave debug ID");
  });

  it("rejects unsafe artifact paths before registration", () => {
    expect(() => normalizeArtifactPath("static/app.js")).not.toThrow();
    expect(() => normalizeArtifactPath("../app.js")).toThrow("..");
    expect(() => normalizeArtifactPath("/static/app.js")).toThrow("relative POSIX path");
    expect(() => normalizeArtifactPath("https://example.test/app.js")).toThrow("relative POSIX path");
  });
});

describe("presigned artifact upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const putBody = new Blob(["bytes"], { type: "application/javascript" });

  it("sends the signed If-None-Match header alongside the content headers", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(putPresignedArtifact(
      "https://uploads.example.test/bundle",
      putBody,
      { "content-type": "application/javascript" },
      "Uploading JavaScript bundle",
    )).resolves.toBe("uploaded");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://uploads.example.test/bundle");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({
      "content-type": "application/javascript",
      "If-None-Match": "*",
    });
  });

  it("treats 412 Precondition Failed as the artifact already being uploaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 412 })));

    await expect(putPresignedArtifact(
      "https://uploads.example.test/bundle",
      putBody,
      { "content-type": "application/javascript" },
      "Uploading JavaScript bundle",
    )).resolves.toBe("already-uploaded");
  });

  it("still fails loudly on any other non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));

    await expect(putPresignedArtifact(
      "https://uploads.example.test/bundle",
      putBody,
      { "content-type": "application/javascript" },
      "Uploading JavaScript bundle",
    )).rejects.toThrow("Uploading JavaScript bundle failed with status 403");
  });
});
