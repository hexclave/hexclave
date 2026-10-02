import { isObjectLike, isRecord } from "@hexclave/shared/dist/utils/objects";
import type { ManagedOtelOptions, ManagedOtelRegistration } from "./otel-managed";
import { runtimeGlobals } from "./runtime-globals";

type OtelSdkModule = {
  registerManagedOtel: (options: ManagedOtelOptions) => ManagedOtelRegistration,
};

type OtelSdkLoadAttempt =
  | { module: OtelSdkModule }
  | { module: null, errors: unknown[] };

function otelSdkSpecifiers(includePackageQualified = true): string[] {
  const base = ["otel", "sdk"].join("-");
  // `.js` for Node ESM dist; extensionless for Vitest/Vite TS resolution.
  const relative = [`./${base}.js`, `./${base}`];
  if (!includePackageQualified) return relative;
  const packageQualified = ["next", "react", "js", "template"]
    .map((name) => ["@hexclave/", name, "/otel"].join(""));
  return [...relative, ...packageQualified];
}

function isTypeScriptSourceUrl(url: string): boolean {
  return /\.[cm]?tsx?(?:[?#]|$)/.test(url);
}

function describeLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOtelSdkModule(value: unknown): value is OtelSdkModule {
  // The guard proves only that `registerManagedOtel` is callable; the precise
  // signature is trusted because the loaded module is our own sibling build.
  return isRecord(value) && typeof value["registerManagedOtel"] === "function";
}

function isCreateRequire(value: unknown): value is (url: string | URL) => (id: string) => unknown {
  return typeof value === "function";
}

/**
 * Sync path for Node: `process.getBuiltinModule("module").createRequire` loads
 * the sibling CJS build without a static import graph. Returns null outside
 * Node, when createRequire cannot load ESM-only siblings, or under Vitest's
 * TypeScript source layout.
 */
function tryRequireOtelSdkSyncAttempt(): OtelSdkLoadAttempt {
  const errors: unknown[] = [];
  try {
    // Read `process` untyped: the ambient Node types claim it always exists,
    // but this guard is exactly for non-Node runtimes where it doesn't.
    const proc = runtimeGlobals["process"];
    if (!isRecord(proc)) return { module: null, errors };
    const getBuiltinModule = proc["getBuiltinModule"];
    if (typeof getBuiltinModule !== "function") return { module: null, errors };
    const nodeModule: unknown = getBuiltinModule.call(proc, "module");
    // Node exposes the `module` builtin as its callable Module constructor,
    // with createRequire attached as a property. Object-only guards reject it.
    if (!isObjectLike(nodeModule)) return { module: null, errors };
    const createRequire: unknown = Reflect.get(nodeModule, "createRequire");
    if (!isCreateRequire(createRequire)) return { module: null, errors };

    const urls = [import.meta.url];
    if (import.meta.url.includes("/dist/esm/")) {
      urls.push(import.meta.url.replace("/dist/esm/", "/dist/"));
    }

    for (const url of urls) {
      const require = createRequire.call(nodeModule, url);
      // A source test must not fall through into a stale built workspace
      // package: that would create a second OTel singleton beside Vitest's
      // source module. Bundled/dist JavaScript still gets the package anchor.
      for (const id of otelSdkSpecifiers(!isTypeScriptSourceUrl(url))) {
        try {
          const mod = require(id);
          if (isOtelSdkModule(mod)) return { module: mod };
          errors.push(new Error(`${id} loaded but is missing registerManagedOtel`));
        } catch (error) {
          errors.push(error);
        }
      }
    }
    return { module: null, errors };
  } catch (error) {
    errors.push(error);
    return { module: null, errors };
  }
}

export function tryRequireOtelSdkSync(): OtelSdkModule | null {
  return tryRequireOtelSdkSyncAttempt().module;
}

let otelSdkImportPromise: Promise<OtelSdkLoadAttempt> | null = null;

function importOtelSdkAttempt(): Promise<OtelSdkLoadAttempt> {
  if (otelSdkImportPromise === null) {
    otelSdkImportPromise = (async (): Promise<OtelSdkLoadAttempt> => {
      const errors: unknown[] = [];
      for (const specifier of otelSdkSpecifiers()) {
        try {
          const mod: unknown = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
          if (isOtelSdkModule(mod)) return { module: mod };
          errors.push(new Error(`${specifier} loaded but is missing registerManagedOtel`));
        } catch (error) {
          errors.push(error);
        }
      }
      return { module: null, errors };
    })();
  }
  return otelSdkImportPromise;
}

/** Async load; works for ESM dist and Vitest source resolution. */
export function importOtelSdk(): Promise<OtelSdkModule | null> {
  return importOtelSdkAttempt().then((result) => result.module);
}

export async function registerManagedOtelAsync(options: ManagedOtelOptions): Promise<ManagedOtelRegistration> {
  const sync = tryRequireOtelSdkSyncAttempt();
  if (sync.module !== null) return sync.module.registerManagedOtel(options);
  const loaded = await importOtelSdkAttempt();
  if (loaded.module !== null) return loaded.module.registerManagedOtel(options);
  const details = [...sync.errors, ...loaded.errors].map(describeLoadError).filter((message) => message !== "");
  throw new Error(
    details.length === 0
      ? "Hexclave managed OpenTelemetry requires a Node.js runtime; the Node OTel SDK could not be loaded"
      : `Hexclave managed OpenTelemetry requires a Node.js runtime; the Node OTel SDK could not be loaded: ${details.join("; ")}`,
  );
}
