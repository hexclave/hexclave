import { describe, expect, it } from "vitest";
import vm from "node:vm";
import {
  buildObservabilityDemoBundle,
  encodeVlq,
  OBSERVABILITY_DEMO_ORIGINAL_SOURCE,
} from "./symbolicated-bundle";
import {
  OBSERVABILITY_DEMO_CODE_FILE,
  OBSERVABILITY_DEMO_ENVIRONMENT,
  OBSERVABILITY_DEMO_ERROR_MESSAGE,
  OBSERVABILITY_DEMO_RELEASE,
  OBSERVABILITY_DEMO_SOURCE_PATH,
  OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY,
} from "../../observability-lab-contract";

const PROJECT_ID = "internal";

describe("observability demo symbolicated bundle", () => {
  it("derives a stable debug ID and keeps the throw on the first mapped line", () => {
    const first = buildObservabilityDemoBundle({
      projectId: PROJECT_ID,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });
    const second = buildObservabilityDemoBundle({
      projectId: PROJECT_ID,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });

    expect(first.debugId).toBe(second.debugId);
    expect(first.debugId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.manifest.artifacts[0].codeFile).toBe(OBSERVABILITY_DEMO_CODE_FILE);
    expect(first.sourceMapJson).toContain(OBSERVABILITY_DEMO_SOURCE_PATH);
    expect(first.sourceMapJson).toContain("debug_id");
    expect(first.bundleSource.indexOf("throw new Error")).toBe(first.throwColumn);
    expect(first.bundleSource.indexOf("hexclave:debug-id-injection:start")).toBeGreaterThan(first.minifiedFunction.length);
  });

  it("maps the minified throw column back to the original throw line", () => {
    const bundle = buildObservabilityDemoBundle({
      projectId: PROJECT_ID,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });
    const parsed: unknown = JSON.parse(bundle.sourceMapJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Prepared source map must be an object.");
    }
    const mappings = Reflect.get(parsed, "mappings");
    if (typeof mappings !== "string") {
      throw new Error("Prepared source map must include mappings.");
    }
    const resolved = originalPositionFor(mappings, bundle.throwColumn);
    expect(resolved).toEqual({
      sourceIndex: 0,
      originalLine: 2,
      originalColumn: OBSERVABILITY_DEMO_ORIGINAL_SOURCE.split("\n")[2]?.indexOf("throw"),
    });
  });

  it("exposes a thrower that fails with the fixture message", () => {
    const bundle = buildObservabilityDemoBundle({
      projectId: PROJECT_ID,
      release: OBSERVABILITY_DEMO_RELEASE,
      environment: OBSERVABILITY_DEMO_ENVIRONMENT,
    });
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(bundle.bundleSource, sandbox);
    const thrower: unknown = sandbox[OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY];
    expect(typeof thrower).toBe("function");
    if (typeof thrower !== "function") {
      throw new Error("Expected the demo bundle to register a thrower.");
    }
    expect(() => thrower()).toThrowError(OBSERVABILITY_DEMO_ERROR_MESSAGE);
    const debugIds: unknown = sandbox._hexclaveDebugIds;
    expect(typeof debugIds).toBe("object");
    expect(debugIds).not.toBeNull();
  });
});

describe("encodeVlq", () => {
  it("encodes the source-map VLQ examples", () => {
    expect(encodeVlq(0)).toBe("A");
    expect(encodeVlq(1)).toBe("C");
    expect(encodeVlq(-1)).toBe("D");
    expect(encodeVlq(16)).toBe("gB");
  });
});

function originalPositionFor(mappings: string, generatedColumn: number): {
  sourceIndex: number,
  originalLine: number,
  originalColumn: number,
} | null {
  const line = mappings.split(";")[0];
  if (line === "") return null;
  let column = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let match: { sourceIndex: number, originalLine: number, originalColumn: number } | null = null;
  for (const segment of line.split(",")) {
    const values = decodeVlqSegment(segment);
    const nextColumn = column + (values[0] ?? 0);
    if (values.length >= 4) {
      sourceIndex += values[1] ?? 0;
      originalLine += values[2] ?? 0;
      originalColumn += values[3] ?? 0;
      if (nextColumn <= generatedColumn) {
        match = { sourceIndex, originalLine, originalColumn };
      }
    }
    column = nextColumn;
    if (column > generatedColumn) break;
  }
  return match;
}

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let result = 0;
  for (const character of segment) {
    const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(character);
    if (digit < 0) throw new Error(`Invalid VLQ character ${character}`);
    result += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const signed = (result & 1) === 1 ? -(result >> 1) : result >> 1;
    values.push(signed);
    shift = 0;
    result = 0;
  }
  return values;
}
