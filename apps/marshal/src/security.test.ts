import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertMocksExplicitlyAllowed, resolveGcpMockUrl } from "./config.js";
import { isAuthorized } from "./marshal-app.js";
import { builderInstanceName, serviceName } from "./naming.js";
import { redactBuildLogLines, validateServiceSpec } from "./services.js";
import { loadAndValidateSourceArchive, validateSourceArchive } from "./source-archive.js";

function writeString(buffer: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error("test tar field is too long");
  buffer.set(bytes, offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
  writeString(buffer, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
}

function sourceArchive(path: string, type: number = 0x30): Uint8Array {
  const tar = new Uint8Array(3 * 512);
  writeString(tar, 0, 100, path);
  writeOctal(tar, 100, 8, 0o644);
  writeOctal(tar, 108, 8, 0);
  writeOctal(tar, 116, 8, 0);
  writeOctal(tar, 124, 12, 0);
  writeOctal(tar, 136, 12, 0);
  tar[156] = type;
  writeString(tar, 257, 6, "ustar");
  tar[263] = 0x30;
  tar[264] = 0x30;
  tar.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of tar.subarray(0, 512)) checksum += byte;
  tar.fill(0, 148, 156);
  writeOctal(tar, 148, 7, checksum);
  tar[155] = 0x20;
  return gzipSync(tar);
}

describe("source archive validation", () => {
  it("accepts the regular-file ustar subset emitted by the CLI", async () => {
    await expect(validateSourceArchive(sourceArchive("src/index.ts"))).resolves.toBeUndefined();
  });

  it("rejects traversal and link entries before the builder receives credentials", async () => {
    await expect(validateSourceArchive(sourceArchive("../escape"))).rejects.toThrow("unsafe entry path");
    await expect(validateSourceArchive(sourceArchive("src/link", 0x32))).rejects.toThrow("only regular files and directories");
    await expect(validateSourceArchive(new Uint8Array([1, 2, 3]))).rejects.toThrow("gzip decompression failed");
  });

  it("releases its inflation slot on both success and failure", async () => {
    // The semaphore is process-wide, so a slot leaked on the rejection path would
    // deadlock every later deploy rather than merely slowing one down. More
    // iterations than MAX_CONCURRENT_INFLATIONS, so a leak cannot hide.
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(validateSourceArchive(new Uint8Array([1, 2, 3]))).rejects.toThrow("gzip decompression failed");
    }
    await expect(validateSourceArchive(sourceArchive("src/index.ts"))).resolves.toBeUndefined();
    // Concurrent callers all finish rather than queueing behind a lost slot.
    await expect(Promise.all([
      validateSourceArchive(sourceArchive("a.ts")),
      validateSourceArchive(sourceArchive("b.ts")),
      validateSourceArchive(sourceArchive("c.ts")),
    ])).resolves.toHaveLength(3);
  });

  it("bounds queued validation before queued requests download their archives", async () => {
    const firstLoadGate: { release: () => void } = {
      release: () => {
        throw new Error("source-load gate was not initialized");
      },
    };
    const firstLoadsBlocked = new Promise<void>((resolve) => {
      firstLoadGate.release = resolve;
    });
    const accepted = Array.from({ length: 27 }, (_unused, index) => loadAndValidateSourceArchive(async () => {
      if (index < 2) await firstLoadsBlocked;
      return sourceArchive(`src/${index}.ts`);
    }));

    await expect(loadAndValidateSourceArchive(async () => sourceArchive("overflow.ts"))).rejects.toThrow("validation is saturated");
    firstLoadGate.release();
    await expect(Promise.all(accepted)).resolves.toHaveLength(27);
  });

  it("hands a released inflation permit directly to the oldest waiter", async () => {
    const gates = Array.from({ length: 4 }, () => {
      const gate: { release: () => void, promise: Promise<void> } = {
        release: () => { throw new Error("gate was not initialized"); },
        promise: Promise.resolve(),
      };
      gate.promise = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return gate;
    });
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const load = async (index: number): Promise<Uint8Array> => {
      activeLoads++;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      await gates[index].promise;
      activeLoads--;
      return sourceArchive(`src/${index}.ts`);
    };

    const first = loadAndValidateSourceArchive(async () => await load(0));
    const second = loadAndValidateSourceArchive(async () => await load(1));
    await Promise.resolve();
    const third = loadAndValidateSourceArchive(async () => await load(2));
    gates[0].release();
    const fourth = new Promise<Uint8Array | null>((resolve, reject) => {
      queueMicrotask(() => {
        loadAndValidateSourceArchive(async () => await load(3)).then(resolve, reject);
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    for (const gate of gates) gate.release();

    await expect(Promise.all([first, second, third, fourth])).resolves.toHaveLength(4);
    expect(maximumActiveLoads).toBe(2);
  });
});

describe("build log redaction", () => {
  it("redacts multiline secrets before splitting the serial stream", () => {
    expect(redactBuildLogLines("before first\nsecond after\n", ["first\nsecond"]))
      .toEqual(["before <redacted> after"]);
  });
});
describe("runtime identity", () => {
  it("does not collide for inputs that shared the former 24-bit suffix", () => {
    const first = serviceName("production", "12345678-tenant", "abcdefgh-2792");
    const second = serviceName("production", "12345678-tenant", "abcdefgh-4185");
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(30);
    expect(second.length).toBeLessThanOrEqual(30);
  });

  it("includes the full deployment identity in builder instance names", () => {
    expect(builderInstanceName("abcdefgh-one", "deployment-1")).not.toBe(builderInstanceName("abcdefgh-one", "deployment-2"));
  });
});

describe("mock safety", () => {
  it("fails closed unless mocks are explicitly enabled", () => {
    expect(() => assertMocksExplicitlyAllowed("mock runtime", {})).toThrow("requires MARSHAL_ALLOW_MOCKS=1");
    expect(() => assertMocksExplicitlyAllowed("mock runtime", { NODE_ENV: "development" })).toThrow("requires MARSHAL_ALLOW_MOCKS=1");
    expect(() => assertMocksExplicitlyAllowed("mock runtime", { MARSHAL_ALLOW_MOCKS: "1" })).not.toThrow();
  });

  it("derives the local GCP mock port from the development port prefix", () => {
    expect(resolveGcpMockUrl("local", "93")).toBe("http://localhost:9348");
    expect(resolveGcpMockUrl("http://gcp-mock:8080/", "93")).toBe("http://gcp-mock:8080");
    expect(resolveGcpMockUrl(undefined, "93")).toBeNull();
  });
});

describe("special environment keys", () => {
  it("preserves __proto__ as an own property during spec validation", () => {
    const env = Object.fromEntries([["__proto__", { value: "safe" }]]);
    const spec = validateServiceSpec({
      config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
      source: { image: "example/image" },
      env,
    });
    expect(Object.hasOwn(spec.env, "__proto__")).toBe(true);
    expect(spec.env.__proto__).toEqual({ value: "safe" });
  });
});

describe("bearer credential matching", () => {
  it("accepts the api key and rejects anything else", () => {
    expect(isAuthorized("Bearer key", ["key", null])).toBe(true);
    expect(isAuthorized("Bearer nope", ["key", null])).toBe(false);
    expect(isAuthorized(null, ["key", null])).toBe(false);
    expect(isAuthorized("key", ["key", null])).toBe(false);
  });

  it("accepts the cron secret only where it is offered as a candidate", () => {
    // The gate passes the cron secret for /v1/maintenance/ and null everywhere else, so the
    // same credential must open the maintenance routes and nothing besides them.
    expect(isAuthorized("Bearer cron", ["key", "cron"])).toBe(true);
    expect(isAuthorized("Bearer cron", ["key", null])).toBe(false);
  });

  // An unset CRON_SECRET reaches config as null, but an empty candidate must never turn the
  // bare header "Bearer " into a valid credential.
  it("never matches an empty candidate", () => {
    expect(isAuthorized("Bearer ", ["key", ""])).toBe(false);
    expect(isAuthorized("Bearer ", ["", ""])).toBe(false);
  });
});
