import { describe, expect, it } from "vitest";
import { flyVolumeName } from "../config.js";
import { computeRevision } from "../revision.js";
import { specIsPublic, specVolume, validateServiceSpec } from "../services.js";
import { candidateVolumes, machineConfigForSlot, selectCanonicalVolume } from "./provider.js";
import type { FlyVolume } from "./client.js";

const TEST_DATA_KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

function spec(config: Record<string, unknown>) {
  return {
    config: { type: "server", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } }, ...config },
    source: { image: "example/image" },
    env: {},
  };
}

describe("persistent volume spec validation", () => {
  it("accepts a volume on a server service", () => {
    expect(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: 10 } } })).config.persistent_volumes)
      .toEqual({ data: { path: "/data", size_gb: 10 } });
    // A nested mount point is equally valid.
    expect(validateServiceSpec(spec({ persistent_volumes: { app_state: { path: "/var/lib/app/data", size_gb: 1 } } })).config.persistent_volumes)
      .toEqual({ app_state: { path: "/var/lib/app/data", size_gb: 1 } });
  });

  it("omits the persistent_volumes key entirely when there is no volume", () => {
    // Not `persistent_volumes: undefined`: computeRevision hashes the serialized spec, so a
    // present-but-undefined key would change the revision of every volumeless service the
    // moment this field was introduced. An empty record collapses the same way.
    expect("persistent_volumes" in validateServiceSpec(spec({})).config).toBe(false);
    expect("persistent_volumes" in validateServiceSpec(spec({ persistent_volumes: {} })).config).toBe(false);
  });

  it("does not change the revision of a volumeless spec", () => {
    // Guards the above at the level that actually matters: adding the field must not force a
    // redeploy of every existing service.
    expect(computeRevision(validateServiceSpec(spec({})), TEST_DATA_KEY)).toBe(
      computeRevision({
        config: { type: "server", public: false, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
        source: { image: "example/image" },
        env: {},
      }, TEST_DATA_KEY),
    );
  });

  it("changes the revision when the volume is added, resized, removed, moved, or re-identified", () => {
    // Without this, a volume-only change (same source) hashes to the previous revision, so
    // applyServiceSpec takes the `changed === false` path, keeps the PREVIOUS stored spec, and
    // silently drops the change while reporting success. The source is identical across all of
    // these on purpose — that is the case a new upload would otherwise mask.
    const none = computeRevision(validateServiceSpec(spec({})), TEST_DATA_KEY);
    const tenGb = computeRevision(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: 10 } } })), TEST_DATA_KEY);
    const fiftyGb = computeRevision(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: 50 } } })), TEST_DATA_KEY);
    const otherPath = computeRevision(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/other", size_gb: 10 } } })), TEST_DATA_KEY);
    // A different id is a different DISK, so it must roll the machine onto it.
    const otherId = computeRevision(validateServiceSpec(spec({ persistent_volumes: { uploads: { path: "/data", size_gb: 10 } } })), TEST_DATA_KEY);
    expect(new Set([none, tenGb, fiftyGb, otherPath, otherId]).size).toBe(5);
  });

  it("rejects a volume on a serverless service", () => {
    // A Fly volume attaches to one machine, so a fleet would give each instance its own
    // separate disk rather than shared storage.
    expect(() => validateServiceSpec(spec({ type: "serverless", max_instances: 2, persistent_volumes: { data: { path: "/data", size_gb: 1 } } })))
      .toThrow(/config\.type must be "server"/);
    expect(() => validateServiceSpec(spec({ type: "serverless", persistent_volumes: { data: { path: "/data", size_gb: 1 } } })))
      .toThrow(/config\.type must be "server"/);
  });

  it("rejects more than one volume per service", () => {
    expect(() => validateServiceSpec(spec({
      persistent_volumes: { data: { path: "/data", size_gb: 1 }, cache: { path: "/cache", size_gb: 1 } },
    }))).toThrow(/at most 1 volume/);
  });

  it("rejects volume ids that would not survive the Fly volume name mapping", () => {
    for (const volumeId of ["Data", "1data", "my-volume", "_data", "", "x".repeat(27)]) {
      expect(() => validateServiceSpec(spec({ persistent_volumes: { [volumeId]: { path: "/data", size_gb: 1 } } })), `id ${JSON.stringify(volumeId)}`)
        .toThrow(/invalid persistent volume id/);
    }
  });

  it("rejects mount paths that are not normalized absolute paths", () => {
    for (const path of ["data", "", "/", "/data/", "/data/../etc", "/data/./x", "/da\\ta", "/da\u0000ta", "//data"]) {
      expect(() => validateServiceSpec(spec({ persistent_volumes: { data: { path, size_gb: 1 } } })), `path ${JSON.stringify(path)}`)
        .toThrow(/config\.persistent_volumes\.data\.path/);
    }
  });

  it("rejects sizes outside the Fly volume bounds", () => {
    for (const sizeGb of [0, -1, 501, 1.5, "10", null]) {
      expect(() => validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: sizeGb } } })), `size ${JSON.stringify(sizeGb)}`)
        .toThrow(/config\.persistent_volumes\.data\.size_gb/);
    }
  });

  it("rejects a malformed persistent_volumes object", () => {
    expect(() => validateServiceSpec(spec({ persistent_volumes: "10gb" }))).toThrow(/config\.persistent_volumes must be an object/);
    expect(() => validateServiceSpec(spec({ persistent_volumes: { data: "10gb" } }))).toThrow(/config\.persistent_volumes\.data must be an object/);
    expect(() => validateServiceSpec(spec({ persistent_volumes: { data: { size_gb: 10 } } }))).toThrow(/config\.persistent_volumes\.data\.path/);
    expect(() => validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data" } } }))).toThrow(/config\.persistent_volumes\.data\.size_gb/);
  });

  it("accepts a size at each end of the supported range", () => {
    expect(specVolume(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: 1 } } })))?.volume.size_gb).toBe(1);
    expect(specVolume(validateServiceSpec(spec({ persistent_volumes: { data: { path: "/data", size_gb: 500 } } })))?.volume.size_gb).toBe(500);
  });

  it("treats explicitly null persistent_volumes as no volume", () => {
    // The backend omits the key rather than sending null, but a hand-rolled client shouldn't
    // get a confusing type error for the obvious spelling.
    expect("persistent_volumes" in validateServiceSpec(spec({ persistent_volumes: null })).config).toBe(false);
  });
});

describe("volume selection", () => {
  function volume(overrides: Partial<FlyVolume> & { id: string, name: string }): FlyVolume {
    return { size_gb: 10, state: "created", attached_machine_id: null, ...overrides } as FlyVolume;
  }

  it("selects the volume whose name matches the configured id", () => {
    const volumes = [
      volume({ id: "vol_other", name: flyVolumeName("uploads") }),
      volume({ id: "vol_data", name: flyVolumeName("data") }),
    ];
    expect(selectCanonicalVolume(volumes, "data")?.id).toBe("vol_data");
    expect(selectCanonicalVolume(volumes, "uploads")?.id).toBe("vol_other");
    // An id with no disk yet selects nothing rather than adopting someone else's.
    expect(selectCanonicalVolume(volumes, "cache")).toBeNull();
  });

  it("prefers an attached volume, then the lowest id, among same-named duplicates", () => {
    // Fly does not enforce unique volume names, so a crashed apply can leave two. The choice
    // must be deterministic or two applies would mount divergent disks.
    const volumes = [
      volume({ id: "vol_c", name: flyVolumeName("data") }),
      volume({ id: "vol_a", name: flyVolumeName("data") }),
      volume({ id: "vol_b", name: flyVolumeName("data"), attached_machine_id: "machine" }),
    ];
    expect(candidateVolumes(volumes, "data").map((candidate) => candidate.id)).toEqual(["vol_b", "vol_a", "vol_c"]);
  });

  it("never selects a volume that is being destroyed", () => {
    const volumes = [
      volume({ id: "vol_dying", name: flyVolumeName("data"), state: "destroying" }),
      volume({ id: "vol_pending", name: flyVolumeName("data"), state: "pending_destruction" }),
    ];
    expect(selectCanonicalVolume(volumes, "data")).toBeNull();
  });
});

describe("machine autostop policy", () => {
  function autostopFor(config: Record<string, unknown>, slot = 0): string {
    const machine = machineConfigForSlot({
      imageRef: "example/image",
      spec: validateServiceSpec(spec(config)),
      revision: "revision",
      ns: "namespace",
      key: "service",
      slot,
      env: {},
      volumeId: null,
    });
    return (machine.services as { autostop: string }[])[0].autostop;
  }

  it("suspends a server and stops a serverless", () => {
    // A server resumes with its memory intact; Fly leaves an attached volume untouched across
    // suspend/resume, and MACHINE_GUEST's 512MB is well inside suspend's 2GB advisory limit.
    expect(autostopFor({ type: "server" })).toBe("suspend");
    expect(autostopFor({ type: "serverless", min_instances: 0, max_instances: 2 })).toBe("stop");
  });

  it("never autostops a pinned instance", () => {
    // Slot 0 of a min_instances: 1 serverless is always-on, so neither policy applies.
    expect(autostopFor({ type: "serverless", min_instances: 1, max_instances: 2 }, 0)).toBe("off");
    expect(autostopFor({ type: "serverless", min_instances: 1, max_instances: 2 }, 1)).toBe("stop");
  });
});

describe("public ingress spec validation", () => {
  it("is private until the service says otherwise, and that changes the revision", () => {
    const privateSpec = validateServiceSpec(spec({}));
    const publicSpec = validateServiceSpec(spec({ public: true }));
    expect(specIsPublic(privateSpec)).toBe(false);
    expect(specIsPublic(publicSpec)).toBe(true);
    // Ingress is machine-visible config, so flipping it must roll the fleet.
    expect(computeRevision(privateSpec, TEST_DATA_KEY)).not.toBe(computeRevision(publicSpec, TEST_DATA_KEY));
  });
});

describe("service type spec validation", () => {
  it("requires a known type", () => {
    expect(() => validateServiceSpec({ ...spec({}), config: { min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } } }))
      .toThrow(/config\.type must be "server" or "serverless"/);
    expect(() => validateServiceSpec(spec({ type: "container" }))).toThrow(/config\.type must be "server" or "serverless"/);
  });

  it("rejects a server whose bounds contradict its type", () => {
    // Coercing instead would leave the stored spec disagreeing with what the caller asked for.
    expect(() => validateServiceSpec(spec({ type: "server", max_instances: 2 }))).toThrow(/config\.type is "server"/);
    expect(() => validateServiceSpec(spec({ type: "server", min_instances: 2, max_instances: 2 }))).toThrow(/config\.type is "server"/);
  });

  it("accepts both instance floors a server can have", () => {
    // A server is one instance, but whether that instance is PINNED is the caller's choice:
    // 0 suspends when idle, 1 stays up — and 1 is the floor every `server` deploys with by
    // default, so rejecting it here would 400 every default deploy after the upload was
    // already consumed.
    for (const minInstances of [0, 1]) {
      expect(validateServiceSpec(spec({ type: "server", min_instances: minInstances, max_instances: 1 })).config)
        .toMatchObject({ type: "server", min_instances: minInstances, max_instances: 1 });
    }
  });

  it("leaves serverless bounds alone", () => {
    const validated = validateServiceSpec(spec({ type: "serverless", min_instances: 1, max_instances: 3 }));
    expect(validated.config).toMatchObject({ type: "serverless", min_instances: 1, max_instances: 3 });
  });
});
