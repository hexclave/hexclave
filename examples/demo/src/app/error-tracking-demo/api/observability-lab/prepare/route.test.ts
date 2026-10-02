import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  prepareObservabilityLab: vi.fn(),
}));

vi.mock("../../../observability-lab-upload", () => ({
  prepareObservabilityLab: mocks.prepareObservabilityLab,
}));

describe("observability lab prepare route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.prepareObservabilityLab.mockReset();
  });

  it("returns the registered release and debug ID without allowing cache reuse", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "http://api.test");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "internal");
    vi.stubEnv("HEXCLAVE_SECRET_SERVER_KEY", "ssk_test");
    mocks.prepareObservabilityLab.mockResolvedValue({
      release: "observability-demo@1.0.0",
      releaseId: "11111111-1111-4111-8111-111111111111",
      debugId: "01234567-89ab-4def-8123-456789abcdef",
      codeFile: "error-tracking-demo/symbolicated/demo-charge.min.js",
      manifestSha256: "a".repeat(64),
      sourceMaps: "uploaded",
    });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      release: "observability-demo@1.0.0",
      debugId: "01234567-89ab-4def-8123-456789abcdef",
    });
    expect(mocks.prepareObservabilityLab).toHaveBeenCalledWith({
      apiUrl: "http://api.test",
      projectId: "internal",
      secretServerKey: "ssk_test",
    });
  });

  it("returns a JSON error when registration fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "http://api.test");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "internal");
    vi.stubEnv("HEXCLAVE_SECRET_SERVER_KEY", "ssk_test");
    mocks.prepareObservabilityLab.mockRejectedValue(new Error("Artifact storage is unavailable."));

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Failed to prepare the observability lab",
    });
  });
});
