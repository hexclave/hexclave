import { existsSync, readFileSync } from "fs";
import { createJiti } from "jiti";
import path from "path";
import { showOnboardingHexclaveConfigValue } from "./config-authoring";
import { isValidConfig, type Config } from "./config/format";
import { detectConfigImportPackage } from "./config-rendering";

const jiti = createJiti(import.meta.url, { moduleCache: false });

/**
 * Thrown when a config file evaluates successfully but its exported `config`
 * isn't a usable shape (missing, or not an object / "show-onboarding" string).
 * Distinct from the underlying loader errors jiti throws, so callers can tell a
 * malformed config apart from a file that simply failed to load.
 */
export class ConfigFileEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileEvalError";
  }
}

/**
 * Walks up from `dir` to find the nearest `package.json` and returns the
 * best SDK package to use for the `HexclaveConfig` type import.
 */
export function detectImportPackageFromDir(dir: string): string | undefined {
  let current = dir;
  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ];
        return detectConfigImportPackage(deps);
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** A config object, or the `"show-onboarding"` sentinel that stands in for one. */
export type ParsedConfigValue = Config | typeof showOnboardingHexclaveConfigValue;

function invalidConfigShape(filePath: string): ConfigFileEvalError {
  return new ConfigFileEvalError(`Invalid config in ${filePath}. The file must export a plain \`config\` object or "${showOnboardingHexclaveConfigValue}".`);
}

/**
 * Evaluates config file content using jiti and returns the exported `config`
 * value.
 *
 * WARNING: This executes arbitrary code via `jiti.evalModule` — only use on
 * content that is fully operator-controlled (local filesystem). Never call
 * this on untrusted input (e.g. content fetched from a remote repository).
 */
export function evalConfigFileContent(content: string, filePath: string): ParsedConfigValue {
  if (content.trim() === "") return {};
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const mod: unknown = jiti.evalModule(content, { filename: resolvedPath });
  if (!isRecord(mod)) {
    throw invalidConfigShape(filePath);
  }
  const config = mod.config;
  if (config === undefined) {
    throw invalidConfigShape(filePath);
  }
  if (typeof config === "string") {
    if (config !== showOnboardingHexclaveConfigValue) {
      throw new ConfigFileEvalError(`Invalid config in ${filePath}. String config values must be "${showOnboardingHexclaveConfigValue}", got "${config}".`);
    }
    return config;
  }
  if (isValidConfig(config)) return config;
  throw invalidConfigShape(filePath);
}

// --- inline vitest tests ---

import.meta.vitest?.test("evalConfigFileContent parses static config exports", ({ expect }) => {
  expect(evalConfigFileContent(`
    import type { StackConfig } from "@hexclave/js";
    export const config: StackConfig = {
      auth: { allowSignUp: true },
      payments: { testMode: false },
    };
  `, "stack.config.ts")).toMatchInlineSnapshot(`
    {
      "auth": {
        "allowSignUp": true,
      },
      "payments": {
        "testMode": false,
      },
    }
  `);
});

import.meta.vitest?.test("evalConfigFileContent parses show-onboarding", ({ expect }) => {
  expect(evalConfigFileContent('export const config = "show-onboarding";', "stack.config.ts")).toBe("show-onboarding");
});

import.meta.vitest?.test("evalConfigFileContent rejects content without config export", ({ expect }) => {
  expect(() => evalConfigFileContent("export const other = {};", "stack.config.ts")).toThrow(/must export/);
});

import.meta.vitest?.test("evalConfigFileContent rejects arbitrary string config values", ({ expect }) => {
  expect(() => evalConfigFileContent('export const config = "arbitrary-string";', "stack.config.ts")).toThrow(/must be "show-onboarding"/);
});

import.meta.vitest?.test("evalConfigFileContent rejects unresolvable config factories", ({ expect }) => {
  expect(() => evalConfigFileContent("export const config = makeConfig();", "stack.config.ts")).toThrow();
});

import.meta.vitest?.test("evalConfigFileContent rejects missing config import targets", ({ expect }) => {
  expect(() => evalConfigFileContent(`
    import missingConfigPart from "./missing-config-part";
    export const config = { auth: missingConfigPart };
  `, "/tmp/hexclave-missing-import-config.ts")).toThrow();
});

import.meta.vitest?.test("evalConfigFileContent surfaces invalid syntax as a loader error, not ConfigFileEvalError", ({ expect }) => {
  // A malformed file fails inside jiti's parser, so the thrown error is a loader
  // error — NOT a ConfigFileEvalError. Callers depend on that distinction to route
  // it to "Failed to load config file" rather than "Invalid config".
  const evalInvalid = () => evalConfigFileContent("export const config = {", "stack.config.ts");
  expect(evalInvalid).toThrow();
  expect(evalInvalid).not.toThrow(ConfigFileEvalError);
});
