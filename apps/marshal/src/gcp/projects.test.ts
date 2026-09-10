import { afterEach, describe, expect, it, vi } from "vitest";
import { GcpApiError, GcpClient } from "./client.js";
import { projectIdForNamespace, resetTenantProjectCacheForTests, TenantProjectManager } from "./projects.js";

afterEach(() => {
  resetTenantProjectCacheForTests();
  vi.restoreAllMocks();
});

describe("tenant project lifecycle", () => {
  it("derives stable globally safe project ids without exposing the namespace", () => {
    const config = { envId: "production", projectPrefix: "hxc-tenant" };
    const first = projectIdForNamespace(config, "customer_name");
    expect(first).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    expect(first).not.toContain("customer");
    expect(projectIdForNamespace(config, "customer_name")).toBe(first);
    expect(projectIdForNamespace(config, "another_customer")).not.toBe(first);
    expect(projectIdForNamespace({ envId: "test", projectPrefix: "123" }, "customer_name")).toMatch(/^h123-/);
  });

  it("creates, bills, enables, and grants only runtime service identities", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request")
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({ name: "operations/create" })
      .mockResolvedValueOnce({ name: "operations/create", done: true })
      .mockResolvedValueOnce({ name: "projects/123456789", projectId: "hxc-test-project", state: "ACTIVE" })
      .mockRejectedValueOnce(new GcpApiError(400, "/v1/projects/hxc-test-project/billingInfo", "Precondition check failed."))
      .mockResolvedValueOnce({ billingEnabled: true })
      .mockResolvedValueOnce({ name: "operations/services" })
      .mockResolvedValueOnce({ name: "operations/services", done: true })
      .mockResolvedValueOnce({ name: "operations/finished.DONE_OPERATION" })
      .mockResolvedValueOnce({
        version: 3,
        etag: "etag",
        bindings: [
          { role: "roles/viewer", members: ["user:operator@example.com"] },
          { role: "roles/editor", members: ["serviceAccount:123456789-compute@developer.gserviceaccount.com", "user:legacy-admin@example.com"] },
        ],
      })
      .mockResolvedValueOnce({ version: 3 });
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "000000-111111-222222",
      parent: "folders/123",
      projectPrefix: "hxc-test",
    });

    const project = await manager.ensureForNamespace("tenant");

    expect(project.projectNumber).toBe("123456789");
    expect(request.mock.calls[0]?.[0]).toContain("projects:search?query=id%3A");
    const createCall = request.mock.calls.find(([url]) => url.endsWith("/v3/projects"));
    expect(createCall?.[1]?.body).toMatchObject({ displayName: "Hexclave tenant tenant" });
    expect("Hexclave tenant tenant".length).toBeLessThanOrEqual(30);
    expect(request.mock.calls.some(([url]) => url.includes("services:batchEnable"))).toBe(true);
    const setPolicyCall = request.mock.calls.find(([url]) => url.includes(":setIamPolicy"));
    expect(setPolicyCall?.[1]?.body).toMatchInlineSnapshot(`
      {
        "policy": {
          "bindings": [
            {
              "members": [
                "user:operator@example.com",
              ],
              "role": "roles/viewer",
            },
            {
              "members": [
                "user:legacy-admin@example.com",
              ],
              "role": "roles/editor",
            },
            {
              "members": [
                "serviceAccount:123456789-compute@developer.gserviceaccount.com",
              ],
              "role": "roles/artifactregistry.writer",
            },
            {
              "members": [
                "serviceAccount:123456789-compute@developer.gserviceaccount.com",
              ],
              "role": "roles/logging.logWriter",
            },
            {
              "members": [
                "serviceAccount:service-123456789@serverless-robot-prod.iam.gserviceaccount.com",
              ],
              "role": "roles/compute.networkUser",
            },
          ],
          "etag": "etag",
          "version": 3,
        },
      }
    `);
  });

  it("treats ALREADY_EXISTS on the create as the project it was asked to reach", async () => {
    const client = new GcpClient();
    // projects:search is eventually consistent, so it can answer "no such project" for one
    // that exists — including one an earlier attempt of this very provision created.
    const request = vi.spyOn(client, "request")
      .mockResolvedValueOnce({ projects: [] })
      .mockRejectedValueOnce(new GcpApiError(409, "/v3/projects", "Requested entity already exists."))
      .mockResolvedValueOnce({ name: "projects/123456789", projectId: "hxc-test-project", state: "ACTIVE" });
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "000000-111111-222222",
      parent: null,
      projectPrefix: "hxc-test",
    });

    await expect(manager.ensureProjectActive("hxc-test-project", "Hexclave tenant tenant")).resolves.toBe("123456789");
    // No operation to wait on: the create never produced one, so the only thing left is to
    // confirm the project is ACTIVE.
    expect(request.mock.calls.every(([url]) => !url.includes("/operations/"))).toBe(true);
  });

  it("still fails a create that was rejected for any other reason", async () => {
    const client = new GcpClient();
    vi.spyOn(client, "request")
      .mockResolvedValueOnce({ projects: [] })
      .mockRejectedValueOnce(new GcpApiError(403, "/v3/projects", "Permission denied on parent folder."));
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "000000-111111-222222",
      parent: "folders/123",
      projectPrefix: "hxc-test",
    });

    await expect(manager.ensureProjectActive("hxc-test-project", "Hexclave tenant tenant")).rejects.toThrow("Permission denied on parent folder.");
  });

  it("refuses to delete a project outside the configured disposable prefix", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request");
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "unused",
      parent: null,
      projectPrefix: "hxc-test",
    });
    await expect(manager.deleteDisposableProject("production-project")).rejects.toThrow("outside Marshal's configured project prefix");
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts the normalized prefix used by generated project ids", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request").mockResolvedValueOnce(null);
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "unused",
      parent: null,
      projectPrefix: "123",
    });

    await manager.deleteDisposableProject("h123-test-project");

    expect(request).toHaveBeenCalledWith(expect.stringContaining("/projects/h123-test-project"), expect.objectContaining({ method: "DELETE" }));
  });

  it("does not issue a permission-hidden delete when the disposable project is absent", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request")
      .mockRejectedValueOnce(new GcpApiError(403, "/v3/projects/hxc-test-absent", "permission denied"))
      .mockResolvedValueOnce({ projects: [] });
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "unused",
      parent: null,
      projectPrefix: "hxc-test",
    });

    await manager.deleteDisposableProject("hxc-test-absent");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(request.mock.calls[1]?.[0]).toContain("projects:search?query=id%3Ahxc-test-absent");
  });

  it("fails loudly when the billing account is out of project quota", async () => {
    // Cloud Billing answers an exhausted billing-account quota with the SAME status and
    // message as a project it cannot see yet; only the QuotaFailure detail differs. Retrying
    // it as propagation would park the pool forever on something waiting cannot fix.
    const client = new GcpClient();
    vi.spyOn(client, "request").mockRejectedValue(new GcpApiError(
      400,
      "/v1/projects/hxc-test-project/billingInfo",
      "Precondition check failed.",
      ["google.rpc.QuotaFailure"],
    ));
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "000000-111111-222222",
      parent: null,
      projectPrefix: "hxc-test",
    });

    await expect(manager.attachBillingOnce("hxc-test-project")).rejects.toThrow("Precondition check failed.");
  });

  it("still treats an unelaborated precondition failure as billing propagation", async () => {
    const client = new GcpClient();
    vi.spyOn(client, "request").mockRejectedValue(new GcpApiError(
      400,
      "/v1/projects/hxc-test-project/billingInfo",
      "Precondition check failed.",
    ));
    const manager = new TenantProjectManager(client, {
      envId: "test",
      billingAccount: "000000-111111-222222",
      parent: null,
      projectPrefix: "hxc-test",
    });

    await expect(manager.attachBillingOnce("hxc-test-project")).resolves.toBe(false);
  });
});
