import { describe, expect, it, vi } from "vitest";
import { hexclaveAppInternalsSymbol } from "../../common";
import { HexclaveClientApp, HexclaveClientAppConstructorOptions, HexclaveClientAppJson } from "../interfaces/client-app";
import { stripBrowserActionQueryParam } from "./client-app-impl";

const baseOptions = {
  baseUrl: "http://localhost:12345",
  projectId: "00000000-0000-4000-8000-000000000000",
  publishableClientKey: "stack-pk-test",
  tokenStore: "memory",
  redirectMethod: "none",
} satisfies HexclaveClientAppConstructorOptions<true, string>;

describe("HexclaveClientApp automatic side effects", () => {
  it("does not inspect browser state when disabled", () => {
    const previousWindow = globalThis["window"];
    const previousDocument = globalThis["document"];
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    const hadPreviousDocument = Reflect.has(globalThis, "document");
    const browserGlobal = {};
    Object.defineProperty(browserGlobal, "location", {
      get() {
        throw new Error("Construction must not inspect the current URL when automatic side effects are disabled");
      },
    });

    Reflect.set(globalThis, "window", browserGlobal);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      get() {
        throw new Error("Construction must not access the document when automatic side effects are disabled");
      },
    });

    try {
      expect(() => new HexclaveClientApp({
        ...baseOptions,
        automaticSideEffects: false,
      })).not.toThrow();
    } finally {
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (hadPreviousDocument) {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
          writable: true,
        });
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("does not initialize automatic side effects when disabled", () => {
    const methodName = "_initializeAutomaticSideEffects";
    const originalInitializer = HexclaveClientApp.prototype[methodName];
    let initializationCalls = 0;
    Reflect.set(HexclaveClientApp.prototype, methodName, () => {
      initializationCalls += 1;
    });

    try {
      new HexclaveClientApp({
        ...baseOptions,
        automaticSideEffects: false,
      });

      expect(initializationCalls).toBe(0);
    } finally {
      Reflect.set(HexclaveClientApp.prototype, methodName, originalInitializer);
    }
  });

  it.each([undefined, true])("retains automatic initialization when automaticSideEffects is %s", (automaticSideEffects) => {
    const methodName = "_initializeAutomaticSideEffects";
    const originalInitializer = HexclaveClientApp.prototype[methodName];
    let initializationCalls = 0;
    Reflect.set(HexclaveClientApp.prototype, methodName, () => {
      initializationCalls += 1;
    });

    try {
      new HexclaveClientApp({
        ...baseOptions,
        automaticSideEffects,
      });

      expect(initializationCalls).toBe(1);
    } finally {
      Reflect.set(HexclaveClientApp.prototype, methodName, originalInitializer);
    }
  });

  it("preserves the option through serialization", () => {
    const app = new HexclaveClientApp({
      ...baseOptions,
      automaticSideEffects: false,
    });

    expect(app[hexclaveAppInternalsSymbol].toClientJson().automaticSideEffects).toBe(false);
  });

  it("preserves stable identity when deserializing with automatic side effects disabled", () => {
    const json: HexclaveClientAppJson<false, string> = {
      baseUrl: baseOptions.baseUrl,
      projectId: baseOptions.projectId,
      publishableClientKey: baseOptions.publishableClientKey,
      tokenStore: null,
      redirectMethod: baseOptions.redirectMethod,
      automaticSideEffects: false,
      uniqueIdentifier: "00000000-0000-4000-8000-000000000001",
    };

    const first = HexclaveClientApp[hexclaveAppInternalsSymbol].fromClientJson(json);
    const second = HexclaveClientApp[hexclaveAppInternalsSymbol].fromClientJson(json);

    expect(second).toBe(first);
  });

  it("keeps stripping the browser action parameter after a router restores it", () => {
    vi.useFakeTimers();
    const previousWindow = globalThis["window"];
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    let currentHref = "http://localhost:12345/?hexclave_action_id=action-id";
    const browserGlobal = {
      location: {
        get href() {
          return currentHref;
        },
      },
      history: {
        state: null,
        replaceState: (_state: null, _title: string, url: string | URL) => {
          currentHref = String(url);
        },
      },
      setTimeout,
    };

    Reflect.set(globalThis, "window", browserGlobal);
    try {
      stripBrowserActionQueryParam();
      currentHref = "http://localhost:12345/?hexclave_action_id=action-id";
      vi.runAllTimers();
      expect(currentHref).toBe("http://localhost:12345/");
    } finally {
      vi.useRealTimers();
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
