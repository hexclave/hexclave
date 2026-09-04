import { describe, expect, it } from "vitest";
import { StackClientApp } from "../interfaces/client-app";

describe("StackClientApp OAuth prefetch", () => {
  it("does not prefetch cross-domain handoff params on construction", () => {
    const prefetchMethodName = "_prefetchCrossDomainHandoffParamsIfNeeded";
    const originalPrefetch = StackClientApp.prototype[prefetchMethodName];
    let prefetchCalls = 0;
    Reflect.set(StackClientApp.prototype, prefetchMethodName, () => {
      prefetchCalls += 1;
    });

    try {
      new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000000",
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "none",
        noAutomaticPrefetch: true,
      });

      expect(prefetchCalls).toBe(0);
    } finally {
      if (originalPrefetch === undefined) {
        Reflect.deleteProperty(StackClientApp.prototype, prefetchMethodName);
      } else {
        Reflect.set(StackClientApp.prototype, prefetchMethodName, originalPrefetch);
      }
    }
  });
});
