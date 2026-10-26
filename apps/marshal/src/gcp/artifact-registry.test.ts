import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactRegistryClient } from "./artifact-registry.js";
import { GcpApiError, GcpClient } from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tenant image repository", () => {
  it("converges when a concurrent first deploy created the repository first", async () => {
    const client = new GcpClient();
    // One repository serves the whole tenant project and this runs on every deployment, so
    // two concurrent first deploys both read 404 and both POST. The loser's ALREADY_EXISTS is
    // the state ensureRepository is asking for, not a reason to fail that deployment.
    const request = vi.spyOn(client, "request")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new GcpApiError(409, "/v1/projects/tenant/locations/us-central1/repositories", "Repository already exists."));

    await expect(new ArtifactRegistryClient(client, "tenant", "us-central1").ensureRepository()).resolves.toBeUndefined();
    // There is no operation to wait on when the create lost the race.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("still fails when the repository cannot be created at all", async () => {
    const client = new GcpClient();
    vi.spyOn(client, "request")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new GcpApiError(403, "/v1/projects/tenant/locations/us-central1/repositories", "Artifact Registry API has not been enabled."));

    await expect(new ArtifactRegistryClient(client, "tenant", "us-central1").ensureRepository())
      .rejects.toThrow("Artifact Registry API has not been enabled.");
  });

  it("does not create a repository that is already there", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request").mockResolvedValueOnce({ name: "projects/tenant/locations/us-central1/repositories/marshal" });

    await new ArtifactRegistryClient(client, "tenant", "us-central1").ensureRepository();

    expect(request).toHaveBeenCalledTimes(1);
  });
});
