import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainClaim, PoolProjectEntry, StoredDeployment, StoredSpec } from "./types.js";

const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...original,
    S3Client: class {
      send = send;
    },
  };
});

vi.mock("./config.js", () => ({
  getConfig: () => ({
    dataEncryptionRootKey: Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
    s3: {
      region: "test",
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "test-bucket",
    },
  }),
  MAX_UPLOAD_BYTES: 1,
  UPLOAD_EXPIRY_SECONDS: 1,
}));

import { assignTenantProject, claimDomain, createDeployment, createPoolProject, readDeployment, readDomainClaimVersioned, readPoolCreationLedgerVersioned, readPoolProject, readSpec, readTenantProjectAssignment, readUpload, releaseDomainClaim, writePoolCreationLedgerConditionally, writeSpec } from "./store.js";

describe("domain claim release", () => {
  const claim = {
    hostname: "app.example.com",
    ns: "test-namespace",
    service_key: "test-service",
    claimed_at_millis: 1,
  } satisfies DomainClaim;

  afterEach(() => {
    send.mockReset();
  });

  it("deletes the claim and index when the ETag still matches", async () => {
    send.mockResolvedValue({});

    await expect(releaseDomainClaim({ value: claim, etag: "claim-etag" })).resolves.toBe(true);

    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      input: {
        Bucket: "test-bucket",
        Key: "domains/app.example.com.json",
        IfMatch: "claim-etag",
      },
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: {
        Bucket: "test-bucket",
        Key: "domain-index/test-namespace/test-service/app.example.com",
      },
    }));
  });

  it("preserves a concurrently replaced claim when the ETag no longer matches", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }));

    await expect(releaseDomainClaim({ value: claim, etag: "stale-etag" })).resolves.toBe(false);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });
});

describe("authoritative state authentication", () => {
  afterEach(() => {
    send.mockReset();
  });

  it("authenticates domain claims and rejects bucket tampering", async () => {
    const claim = {
      hostname: "app.example.com",
      ns: "tenant-a",
      service_key: "web",
      claimed_at_millis: 1,
    } satisfies DomainClaim;
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ETag: "claim-etag" });
    await expect(claimDomain(claim)).resolves.toBe(true);

    const body = send.mock.calls[1][0].input.Body;
    expect(typeof body).toBe("string");
    const persisted: unknown = JSON.parse(body);
    send.mockResolvedValueOnce({ Body: { transformToString: async () => body }, ETag: "claim-etag" });
    await expect(readDomainClaimVersioned(claim.hostname)).resolves.toEqual({ value: claim, etag: "claim-etag" });

    if (typeof persisted !== "object" || persisted === null || !("value" in persisted) || typeof persisted.value !== "object" || persisted.value === null) {
      throw new Error("test expected an authenticated domain-claim envelope");
    }
    const tampered = { ...persisted, value: { ...persisted.value, ns: "tenant-b" } };
    send.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(tampered) }, ETag: "forged-etag" });
    await expect(readDomainClaimVersioned(claim.hostname)).rejects.toThrow("failed authentication");
  });

  it("authenticates tenant project assignments and rejects unsigned legacy objects", async () => {
    send.mockResolvedValueOnce({ ETag: "assignment-etag" });
    await expect(assignTenantProject("tenant-a", "hxc-tenant-a")).resolves.toBe("hxc-tenant-a");
    const body = send.mock.calls[0][0].input.Body;
    expect(typeof body).toBe("string");

    send.mockResolvedValueOnce({ Body: { transformToString: async () => body } });
    await expect(readTenantProjectAssignment("tenant-a")).resolves.toBe("hxc-tenant-a");

    send.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ project_id: "hxc-tenant-b" }) } });
    await expect(readTenantProjectAssignment("tenant-a")).rejects.toThrow("is unsigned");
  });

  it("authenticates the project creation-rate ledger", async () => {
    send.mockResolvedValueOnce({ ETag: '"v1"' });
    await expect(writePoolCreationLedgerConditionally([100, 200], null)).resolves.toBe(true);
    const body = send.mock.calls[0][0].input.Body;
    expect(typeof body).toBe("string");
    // A first write must not overwrite a ledger someone else already created.
    expect(send.mock.calls[0][0].input.IfNoneMatch).toBe("*");

    send.mockResolvedValueOnce({ ETag: '"v1"', Body: { transformToString: async () => body } });
    await expect(readPoolCreationLedgerVersioned()).resolves.toEqual({ etag: '"v1"', createdAtMillis: [100, 200] });

    send.mockResolvedValueOnce({ ETag: '"v1"', Body: { transformToString: async () => JSON.stringify({ created_at_millis: [100, 200] }) } });
    await expect(readPoolCreationLedgerVersioned()).rejects.toThrow("is unsigned");
  });

  it("does not let an unsigned ready-pool record become a signed tenant assignment", async () => {
    const entry = {
      state: "ready",
      created_at_millis: 1,
      state_since_millis: 2,
      attempts: 0,
      last_error: null,
      operation_name: null,
      project_number: "123456789",
      ns: null,
    } satisfies PoolProjectEntry;
    send.mockResolvedValueOnce({ ETag: "pool-etag" });
    await expect(createPoolProject("hxc-pool-project", entry)).resolves.toBe(true);
    const body = send.mock.calls[0][0].input.Body;
    expect(typeof body).toBe("string");

    send.mockResolvedValueOnce({ Body: { transformToString: async () => body }, ETag: "pool-etag" });
    await expect(readPoolProject("hxc-pool-project")).resolves.toEqual({ value: entry, etag: "pool-etag" });

    send.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(entry) }, ETag: "forged-etag" });
    await expect(readPoolProject("hxc-pool-project")).rejects.toThrow("is unsigned");
  });
});

describe("stored service spec encryption", () => {
  const spec = {
    ns: "test-namespace",
    key: "web",
    spec: {
      config: { type: "serverless", public: false, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
      source: { image: "registry.example.com/web@sha256:abc" },
      env: {
        API_TOKEN: { value: "tenant-secret-value" },
        DATABASE_URL: { ref: "database.internal_url" },
      },
    },
    revision: "abc123def456",
    created_at_millis: 1,
    updated_at_millis: 2,
    last_apply_error: null,
  } satisfies StoredSpec;

  afterEach(() => {
    send.mockReset();
  });

  it("never writes plaintext environment values and decrypts the stored payload", async () => {
    send.mockResolvedValueOnce({ ETag: "encrypted-etag" });
    await expect(writeSpec(spec, { ifNoneMatch: true })).resolves.toBe("encrypted-etag");

    const command = send.mock.calls[0][0];
    const body = command.input.Body;
    expect(typeof body).toBe("string");
    expect(body).not.toContain("tenant-secret-value");
    expect(body).not.toContain("database.internal_url");
    expect(body).toContain("encrypted_env");

    send.mockResolvedValueOnce({
      Body: { transformToString: async () => body },
      ETag: "encrypted-etag",
    });
    await expect(readSpec(spec.ns, spec.key)).resolves.toEqual(spec);
  });

  it("rejects ciphertext moved to another object or paired with modified plaintext fields", async () => {
    send.mockResolvedValueOnce({ ETag: "encrypted-etag" });
    await writeSpec(spec, { ifNoneMatch: true });
    const body = send.mock.calls[0][0].input.Body;
    if (typeof body !== "string") throw new Error("test S3 request body was not a string");

    send.mockResolvedValueOnce({ Body: { transformToString: async () => body }, ETag: "moved-etag" });
    await expect(readSpec(spec.ns, "worker")).rejects.toThrow(/identity does not match requested object/);

    const tamperedBody = body.replace('"revision":"abc123def456"', '"revision":"attacker-value"');
    expect(tamperedBody).not.toBe(body);
    send.mockResolvedValueOnce({ Body: { transformToString: async () => tamperedBody }, ETag: "tampered-etag" });
    await expect(readSpec(spec.ns, spec.key)).rejects.toThrow();
  });

  it("atomically upgrades a legacy plaintext spec on first read", async () => {
    send.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(spec) },
      ETag: "legacy-etag",
    });
    send.mockResolvedValueOnce({ ETag: "upgraded-etag" });

    await expect(readSpec(spec.ns, spec.key)).resolves.toEqual(spec);

    const upgradedBody = send.mock.calls[1][0].input.Body;
    expect(upgradedBody).not.toContain("tenant-secret-value");
    expect(send.mock.calls[1][0].input.IfMatch).toBe("legacy-etag");
  });
});

describe("stored deployment encryption", () => {
  const deployment = {
    id: "01J00000000000000000000000",
    ns: "test-namespace",
    source_id: "source",
    status: "building",
    has_logs: true,
    error: null,
    started_at_millis: 1,
    finished_at_millis: null,
    order: [["web"]],
    targets: [{
      service_key: "web",
      dockerfile_path: "Dockerfile",
      spec: {
        config: { type: "serverless", public: false, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
        env: { API_TOKEN: { value: "historical-deployment-secret" } },
      },
    }],
    services: { web: { service_key: "web", status: "building", revision: null, url: null, image: null, error: null } },
    images: {},
    builder_app: null,
    builder_machine_id: null,
    upload_id: "00000000-0000-0000-0000-000000000000",
  } satisfies StoredDeployment;

  afterEach(() => {
    send.mockReset();
  });

  it("never writes target environment values in plaintext and decrypts them on read", async () => {
    send.mockResolvedValueOnce({ ETag: "deployment-etag" });
    await expect(createDeployment(deployment)).resolves.toBe("deployment-etag");
    const body = send.mock.calls[0][0].input.Body;
    if (typeof body !== "string") throw new Error("test S3 request body was not a string");
    expect(body).not.toContain("historical-deployment-secret");
    expect(body).toContain("encrypted_target_env");

    send.mockResolvedValueOnce({ Body: { transformToString: async () => body }, ETag: "deployment-etag" });
    await expect(readDeployment(deployment.ns, deployment.id)).resolves.toEqual(deployment);
  });

  it("atomically upgrades a legacy plaintext deployment on first read", async () => {
    send.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(deployment) },
      ETag: "legacy-deployment-etag",
    });
    send.mockResolvedValueOnce({ ETag: "upgraded-deployment-etag" });

    await expect(readDeployment(deployment.ns, deployment.id)).resolves.toEqual(deployment);
    const upgradedBody = send.mock.calls[1][0].input.Body;
    expect(upgradedBody).not.toContain("historical-deployment-secret");
    expect(send.mock.calls[1][0].input.IfMatch).toBe("legacy-deployment-etag");
  });
});

describe("fenced upload reads", () => {
  afterEach(() => {
    send.mockReset();
  });

  it("refuses an upload replaced after its HEAD request", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }));

    await expect(readUpload("test-namespace", "upload-id", "expected-etag", 1024)).resolves.toBeNull();
    expect(send.mock.calls[0][0].input.IfMatch).toBe("expected-etag");
  });

  it("stops streaming when S3 sends more bytes than the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    send.mockResolvedValueOnce({
      Body: { transformToWebStream: () => body },
    });

    await expect(readUpload("test-namespace", "upload-id", "expected-etag", 3)).resolves.toBeNull();
  });
});
