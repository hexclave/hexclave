import { describe, expect, it } from "vitest";
import { existingProviderConflictFor, normalizeTraceSampleRate, observabilityOptionsToJson, resolveClientOpenTelemetryProvider, resolveOpenTelemetryProviderMode, shouldInstallManagedOtel } from "./observability-config";

describe("normalizeTraceSampleRate", () => {
  it("defaults to 10% root trace sampling", () => {
    expect(normalizeTraceSampleRate(undefined)).toBe(0.1);
  });

  it("accepts the top-level trace rate and the deprecated network alias", () => {
    expect(normalizeTraceSampleRate({ traceSampleRate: 0.1 })).toBe(0.1);
    expect(normalizeTraceSampleRate({ traceSampleRate: 0.25 })).toBe(0.25);
  });

  it("rejects invalid or conflicting rates at app construction", () => {
    expect(() => normalizeTraceSampleRate({ traceSampleRate: -0.1 })).toThrow(/between 0 and 1/);
    expect(() => normalizeTraceSampleRate({ traceSampleRate: Number.NaN })).toThrow(/between 0 and 1/);
  });
});

describe("OpenTelemetry provider mode", () => {
  it("defaults to managed", () => {
    expect(resolveOpenTelemetryProviderMode(undefined)).toBe("managed");
  });

  it("installs a managed SDK unless the host owns the provider", () => {
    expect(shouldInstallManagedOtel("managed")).toBe(true);
    expect(shouldInstallManagedOtel("auto")).toBe(true);
    expect(shouldInstallManagedOtel("existing-provider")).toBe(false);
  });

  it("adopts a host provider only in auto mode", () => {
    expect(existingProviderConflictFor("managed")).toBe("throw");
    expect(existingProviderConflictFor("auto")).toBe("adopt");
    expect(() => existingProviderConflictFor("existing-provider")).toThrow("does not register a managed SDK");
  });

  it("maps auto to managed on the browser client", () => {
    expect(resolveClientOpenTelemetryProvider("auto", true)).toBe("managed");
    expect(resolveClientOpenTelemetryProvider("existing-provider", true)).toBe("existing-provider");
    expect(resolveClientOpenTelemetryProvider("managed", false)).toBe("disabled");
  });

  it("keeps a managed delivery provider when analytics is on and observability is off", () => {
    expect(resolveClientOpenTelemetryProvider("managed", false, true)).toBe("managed");
    expect(resolveClientOpenTelemetryProvider(undefined, false, true)).toBe("managed");
    expect(resolveClientOpenTelemetryProvider("auto", false, true)).toBe("managed");
    expect(resolveClientOpenTelemetryProvider("managed", false, false)).toBe("disabled");
  });

  it("honors existing-provider when analytics is on and observability is off", () => {
    expect(resolveClientOpenTelemetryProvider("existing-provider", false, true)).toBe("existing-provider");
    expect(resolveClientOpenTelemetryProvider("existing-provider", false, false)).toBe("disabled");
  });
});

describe("observabilityOptionsToJson", () => {
  it("omits runtime processor callbacks from the SSR payload", () => {
    const beforeSend = () => null;
    const eventProcessor = () => null;
    expect(observabilityOptionsToJson({
      enabled: true,
      errorCapture: {
        enabled: true,
        ignoreErrors: ["fixture"],
        eventProcessors: [eventProcessor],
        beforeSend,
      },
    })).toEqual({
      enabled: true,
      errorCapture: {
        enabled: true,
        ignoreErrors: ["fixture"],
      },
    });
  });

  it("omits attachment delivery callbacks from the SSR payload", () => {
    const attachmentTransport = {
      upload: async () => {
        throw new Error("fixture");
      },
    };
    const onAttachmentPending = () => undefined;
    expect(observabilityOptionsToJson({
      errorCapture: { attachmentTransport, onAttachmentPending },
    })).toEqual({ errorCapture: {} });
  });
});
