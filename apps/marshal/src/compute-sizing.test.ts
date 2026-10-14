import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVERLESS_MEMORY_MB,
  DEFAULT_SERVER_MEMORY_MB,
  RAILPACK_MIN_BUILDER_MEMORY_MB,
  SERVERLESS_CPU_BY_MEMORY_MB,
  SERVER_MACHINE_TYPE_BY_MEMORY_MB,
  builderMachineFor,
  buildkitTmpfsSize,
  serviceMemoryMb,
} from "./config.js";
import { computeRevision } from "./revision.js";
import { validateServiceSpec } from "./services.js";

// Every size in this file is a GCP fact (machine types, Cloud Run CPU pairs), so the specs
// are validated against that runtime's ladder.
const validateGcpSpec = (body: unknown) => validateServiceSpec(body, "gcp");

const TEST_DATA_KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

function spec(config: Record<string, unknown>) {
  return {
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } }, ...config },
    source: { image: "example/image" },
    env: {},
  };
}

describe("service memory validation", () => {
  it("accepts every size its own type has a machine for", () => {
    // The type's own default normalizes back OUT (see below), so it round-trips
    // as absent rather than as itself — which resolves to the same machine.
    for (const memoryMb of Object.keys(SERVERLESS_CPU_BY_MEMORY_MB).map(Number)) {
      const applied = validateGcpSpec(spec({ memory_mb: memoryMb })).config.memory_mb;
      expect(applied).toBe(memoryMb === DEFAULT_SERVERLESS_MEMORY_MB ? undefined : memoryMb);
    }
    for (const memoryMb of Object.keys(SERVER_MACHINE_TYPE_BY_MEMORY_MB).map(Number)) {
      const applied = validateGcpSpec(spec({ type: "server", max_instances: 1, memory_mb: memoryMb })).config.memory_mb;
      expect(applied).toBe(memoryMb === DEFAULT_SERVER_MEMORY_MB ? undefined : memoryMb);
    }
    // Whatever it round-trips as, the resolved machine is the one asked for.
    for (const memoryMb of Object.keys(SERVER_MACHINE_TYPE_BY_MEMORY_MB).map(Number)) {
      expect(serviceMemoryMb("gcp", validateGcpSpec(spec({ type: "server", memory_mb: memoryMb })))).toBe(memoryMb);
    }
  });

  it("refuses a size the service's own runtime has no shape for", () => {
    // 512MB is a legal container and NOT a legal machine: the smallest instance
    // shape carries a full gigabyte, so a "server" cannot be given one.
    expect(() => validateGcpSpec(spec({ memory_mb: 512 }))).not.toThrow();
    expect(() => validateGcpSpec(spec({ type: "server", memory_mb: 512 }))).toThrow(/memory_mb must be one of/);
    // Off-ladder, non-integer and wrong-typed values are all the same refusal:
    // this is the boundary that turns a request into provider config.
    for (const bad of [3072, 0, -1024, 1024.5, "4GB", "4096", true, {}]) {
      expect(() => validateGcpSpec(spec({ memory_mb: bad }))).toThrow(/memory_mb/);
    }
  });

  it("normalizes the type's own default back out, so restating it is a no-op", () => {
    // The guarantee this exists for: writing `memory: "1GB"` next to a server
    // already running 1GB must not replace the machine. The backend normalizes
    // too, but this boundary does not trust the one above it.
    expect("memory_mb" in validateGcpSpec(spec({ memory_mb: DEFAULT_SERVERLESS_MEMORY_MB })).config).toBe(false);
    expect("memory_mb" in validateGcpSpec(spec({ type: "server", memory_mb: DEFAULT_SERVER_MEMORY_MB })).config).toBe(false);
    // A server's default is a legal serverless size and vice versa, so the
    // normalization is per TYPE rather than against one flat value.
    expect(validateGcpSpec(spec({ memory_mb: DEFAULT_SERVER_MEMORY_MB })).config.memory_mb).toBe(DEFAULT_SERVER_MEMORY_MB);
  });

  it("omits the memory_mb key entirely when the caller names no size", () => {
    // Not `memory_mb: undefined`, and not the default written out: computeRevision
    // hashes the serialized spec, so either would change the revision of every
    // service that predates this field — and for a "server" a changed revision
    // means the VM is deleted and recreated.
    expect("memory_mb" in validateGcpSpec(spec({})).config).toBe(false);
    expect("memory_mb" in validateGcpSpec(spec({ memory_mb: null })).config).toBe(false);
  });

  it("resolves an absent size to the type's default", () => {
    expect(serviceMemoryMb("gcp", validateGcpSpec(spec({})))).toBe(DEFAULT_SERVERLESS_MEMORY_MB);
    expect(serviceMemoryMb("gcp", validateGcpSpec(spec({ type: "server" })))).toBe(DEFAULT_SERVER_MEMORY_MB);
    // Every default is a size its own runtime actually has a shape for.
    expect(SERVERLESS_CPU_BY_MEMORY_MB[DEFAULT_SERVERLESS_MEMORY_MB]).toBeDefined();
    expect(SERVER_MACHINE_TYPE_BY_MEMORY_MB[DEFAULT_SERVER_MEMORY_MB]).toBeDefined();
  });
});

describe("memory in the revision", () => {
  const revision = (config: Record<string, unknown>) => computeRevision(validateGcpSpec(spec(config)), TEST_DATA_KEY);

  it("changes the revision, because otherwise a resize could never happen", () => {
    // applyInstance returns the existing VM untouched when the revision matches,
    // and applyServiceSpec keeps the previous stored spec — so a size that hashed
    // identically would be accepted and then silently dropped, forever.
    expect(revision({ memory_mb: 2048 })).not.toBe(revision({ memory_mb: 4096 }));
  });

  it("hashes an explicitly-default size identically to an omitted one", () => {
    expect(revision({ memory_mb: DEFAULT_SERVERLESS_MEMORY_MB })).toBe(revision({}));
  });

  it("leaves a service that names no size hashing exactly as it did before the field existed", () => {
    // The guarantee that makes this safe to roll out: no existing service is
    // re-rolled just because Marshal learned about memory.
    const withoutMemory = { type: "serverless", public: false, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } };
    expect(revision({})).toBe(computeRevision({
      config: withoutMemory as never,
      source: { image: "example/image" },
      env: {},
    }, TEST_DATA_KEY));
  });
});

describe("builder sizing", () => {
  it("gives an unspecified build the floor its shape needs", () => {
    expect(builderMachineFor({ requestedMemoryMb: null, isRailpackBuild: false }).machineType).toBe("e2-standard-2");
    // An auto-detected build unpacks a large base image and holds the whole
    // snapshot store in memory; the smaller machine has been measured dying of it.
    expect(builderMachineFor({ requestedMemoryMb: null, isRailpackBuild: true }).memoryMb).toBe(RAILPACK_MIN_BUILDER_MEMORY_MB);
  });

  it("raises a request below the floor rather than refusing it", () => {
    // The floor is a fact about how much machine the build takes, not an
    // entitlement — failing a deploy over a size that merely would not have
    // worked is worse than quietly giving one that does.
    expect(builderMachineFor({ requestedMemoryMb: 8192, isRailpackBuild: true }).memoryMb).toBe(RAILPACK_MIN_BUILDER_MEMORY_MB);
    // Above the floor the request stands, on either build shape.
    expect(builderMachineFor({ requestedMemoryMb: 32768, isRailpackBuild: true }).machineType).toBe("e2-standard-8");
    expect(builderMachineFor({ requestedMemoryMb: 32768, isRailpackBuild: false }).machineType).toBe("e2-standard-8");
  });

  it("grows the disk with the machine", () => {
    // ENOSPC on the boot disk is the same failure as ENOSPC in the snapshot
    // store, arriving from the other direction.
    const sizes = [8192, 16384, 32768].map((memoryMb) => builderMachineFor({ requestedMemoryMb: memoryMb, isRailpackBuild: false }).diskSizeGb);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("scales the buildkit tmpfs with the machine", () => {
    // Fixed, a large builder would gain nothing from its extra memory: the
    // snapshot store is what a big dependency tree fills first.
    expect(buildkitTmpfsSize(16384)).toBe("9g");
    expect(buildkitTmpfsSize(32768)).toBe("19g");
    // Always leaves room for the build itself, and never degenerates to 0g.
    for (const memoryMb of [8192, 16384, 32768]) {
      const tmpfsGb = Number(buildkitTmpfsSize(memoryMb).replace("g", ""));
      expect(tmpfsGb).toBeGreaterThan(0);
      expect(tmpfsGb).toBeLessThan(memoryMb / 1024);
    }
  });
});
