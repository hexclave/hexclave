import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRequireOtelSdkSync } from "./otel-sdk-loader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OTel SDK loader", () => {
  it("accepts Node's callable module builtin in the synchronous path", () => {
    const registerManagedOtel = vi.fn();
    const nodeModule = function NodeModule() {};
    Reflect.set(nodeModule, "createRequire", () => () => ({ registerManagedOtel }));
    vi.stubGlobal("process", {
      getBuiltinModule: () => nodeModule,
    });

    expect(tryRequireOtelSdkSync()?.registerManagedOtel).toBe(registerManagedOtel);
  });

  it("does not mix built workspace packages into a TypeScript source run", () => {
    const requestedIds: string[] = [];
    const nodeModule = function NodeModule() {};
    Reflect.set(nodeModule, "createRequire", () => (id: string) => {
      requestedIds.push(id);
      throw new Error(`Missing test module: ${id}`);
    });
    vi.stubGlobal("process", {
      getBuiltinModule: () => nodeModule,
    });

    expect(tryRequireOtelSdkSync()).toBeNull();
    expect(requestedIds).toEqual(["./otel-sdk.js", "./otel-sdk"]);
  });
});
