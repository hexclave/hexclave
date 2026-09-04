import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

type Framework = "next" | "react" | "js";

type PackageJson = {
  dependencies?: Record<string, string>,
  devDependencies?: Record<string, string>,
  [key: string]: unknown,
};

type CheckCtx = {
  projectDir: string,
  packageJson: PackageJson,
  framework: Framework,
  srcPrefix: "src/" | "",
};

type CheckStatus = "pass" | "fail" | "warn";

type CheckResult = {
  id: string,
  label: string,
  status: CheckStatus,
  detail?: string,
  hint?: string,
};

type CheckSpec = {
  id: string,
  label: string,
  run: (ctx: CheckCtx) => CheckResult | null | Promise<CheckResult | null>,
};

type DoctorOptions = {
  outputDir?: string,
  framework?: string,
  json?: boolean,
};

type Report = {
  framework: Framework,
  projectDir: string,
  checks: CheckResult[],
  passed: number,
  failed: number,
  warned: number,
};

export function registerDoctorCommand(program: Command) {
  program
    .command("doctor")
    .description("Check that Hexclave is correctly wired up in your project")
    .option("--output-dir <dir>", "Project root to inspect (defaults to cwd)")
    .option("--framework <fw>", "Override framework detection (next | react | js)")
    .option("--json", "Emit a machine-readable JSON report")
    .action(async (opts: DoctorOptions) => {
      const parentJson = Boolean((program.opts() as { json?: boolean }).json);
      const exitCode = await runDoctor({ ...opts, json: opts.json || parentJson });
      process.exit(exitCode);
    });
}

async function runDoctor(opts: DoctorOptions): Promise<number> {
  const projectDir = opts.outputDir ? path.resolve(opts.outputDir) : process.cwd();

  const pkgRead = readPackageJson(projectDir);
  if (pkgRead.kind === "missing") {
    if (opts.json) {
      console.log(JSON.stringify({ error: "no package.json", projectDir }));
    } else {
      console.error(`No package.json found at ${projectDir}. Doctor needs a Node.js project root.`);
    }
    return 1;
  }
  if (pkgRead.kind === "invalid") {
    if (opts.json) {
      console.log(JSON.stringify({ error: "invalid package.json", projectDir, detail: pkgRead.error }));
    } else {
      console.error(`Invalid package.json at ${projectDir}: ${pkgRead.error}`);
    }
    return 1;
  }
  const packageJson = pkgRead.value;

  const framework = resolveFramework(opts.framework, packageJson, projectDir);
  if (framework.kind === "unsupported") {
    if (opts.json) {
      console.log(JSON.stringify({ error: framework.reason, projectDir }));
    } else {
      console.error(framework.reason);
    }
    return 1;
  }

  const srcPrefix = resolveSrcPrefix(framework.value, projectDir);
  const ctx: CheckCtx = { projectDir, packageJson, framework: framework.value, srcPrefix };
  const specs = getChecks(framework.value);

  const results: CheckResult[] = [];
  for (const spec of specs) {
    const r = await spec.run(ctx);
    if (r) results.push(r);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;

  const report: Report = { framework: framework.value, projectDir, checks: results, passed, failed, warned };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report);
  }

  return failed > 0 ? 1 : 0;
}

type PackageJsonRead =
  | { kind: "ok", value: PackageJson }
  | { kind: "missing" }
  | { kind: "invalid", error: string };

function isPackageJson(value: unknown): value is PackageJson {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPackageJson(projectDir: string): PackageJsonRead {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) return { kind: "missing" };
  const raw = fs.readFileSync(pkgPath, "utf-8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPackageJson(parsed)) {
      return { kind: "invalid", error: "package.json must be a JSON object." };
    }
    return { kind: "ok", value: parsed };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: "invalid", error: error.message };
    }
    throw error;
  }
}

type FrameworkResolution =
  | { kind: "ok", value: Framework }
  | { kind: "unsupported", reason: string };

function resolveSrcPrefix(framework: Framework, projectDir: string): "src/" | "" {
  if (framework === "next") {
    return fs.existsSync(path.join(projectDir, "src/app")) ? "src/" : "";
  }
  return fs.existsSync(path.join(projectDir, "src")) ? "src/" : "";
}

function resolveFramework(
  override: string | undefined,
  pkg: PackageJson,
  projectDir: string,
): FrameworkResolution {
  if (override) {
    if (override === "next" || override === "react" || override === "js") {
      return { kind: "ok", value: override };
    }
    return { kind: "unsupported", reason: `Unknown framework: ${override}. Expected one of: next, react, js.` };
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  if (allDeps.next) {
    const hasAppRouter = fs.existsSync(path.join(projectDir, "app"))
      || fs.existsSync(path.join(projectDir, "src/app"));
    if (!hasAppRouter) {
      return {
        kind: "unsupported",
        reason: "Detected Next.js but no app router (app/ or src/app/). The pages router is not yet supported by Hexclave doctor.",
      };
    }
    return { kind: "ok", value: "next" };
  }

  if (allDeps.react || allDeps["react-dom"]) {
    return { kind: "ok", value: "react" };
  }

  if (Object.keys(allDeps).length > 0) {
    return { kind: "ok", value: "js" };
  }

  return { kind: "unsupported", reason: "package.json has no dependencies declared — install one of @hexclave/next, @hexclave/react, or @hexclave/js to begin." };
}

function getChecks(framework: Framework): CheckSpec[] {
  switch (framework) {
    case "next": {
      return NEXT_CHECKS;
    }
    case "react": {
      return REACT_CHECKS;
    }
    case "js": {
      return JS_CHECKS;
    }
  }
}

const NEXT_CHECKS: CheckSpec[] = [
  packageInstalledCheck("next.package", "@hexclave/next"),
  fileExistsCheck("next.client-app", "Hexclave client app instance", [
    "hexclave/client.ts", "hexclave/client.tsx",
    "stack/client.ts", "stack/client.tsx",
  ]),
  fileExistsCheck("next.server-app", "Hexclave server app instance", [
    "hexclave/server.ts", "hexclave/server.tsx",
    "stack/server.ts", "stack/server.tsx",
  ]),
  fileExistsCheck("next.handler-route", "Handler route", [
    "app/handler/[...hexclave]/page.tsx", "app/handler/[...hexclave]/page.ts",
    "app/handler/[...hexclave]/page.jsx", "app/handler/[...hexclave]/page.js",
    "app/handler/[...stack]/page.tsx", "app/handler/[...stack]/page.ts",
    "app/handler/[...stack]/page.jsx", "app/handler/[...stack]/page.js",
  ], "Create app/handler/[...hexclave]/page.tsx that renders <HexclaveHandler fullPage />."),
  layoutWrapsStackProviderCheck(),
  envVarsCheck([
    { names: ["NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "NEXT_PUBLIC_STACK_PROJECT_ID"], severity: "fail" },
    { names: ["NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY", "NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY"], severity: "warn" },
    { names: ["HEXCLAVE_SECRET_SERVER_KEY", "STACK_SECRET_SERVER_KEY"], severity: "fail" },
  ]),
  configFileCheck(),
];

const REACT_CHECKS: CheckSpec[] = [
  packageInstalledCheck("react.package", "@hexclave/react"),
  fileExistsCheck("react.client-app", "Hexclave client app instance", [
    "hexclave/client.ts", "hexclave/client.tsx", "hexclave/client.js", "hexclave/client.jsx",
    "stack/client.ts", "stack/client.tsx", "stack/client.js", "stack/client.jsx",
  ]),
  envVarsCheck([
    { names: ["VITE_HEXCLAVE_PROJECT_ID", "VITE_STACK_PROJECT_ID"], severity: "fail" },
    { names: ["VITE_HEXCLAVE_PUBLISHABLE_CLIENT_KEY", "VITE_STACK_PUBLISHABLE_CLIENT_KEY"], severity: "warn" },
  ]),
  configFileCheck(),
];

const JS_CHECKS: CheckSpec[] = [
  packageInstalledCheck("js.package", "@hexclave/js"),
  fileExistsCheck("js.app", "Hexclave app instance", [
    "hexclave/client.ts", "hexclave/client.tsx", "hexclave/client.js", "hexclave/client.jsx",
    "hexclave/server.ts", "hexclave/server.tsx", "hexclave/server.js", "hexclave/server.jsx",
    "stack/client.ts", "stack/client.tsx", "stack/client.js", "stack/client.jsx",
    "stack/server.ts", "stack/server.tsx", "stack/server.js", "stack/server.jsx",
  ]),
  envVarsCheck([
    // PUBLIC_* aliases cover SvelteKit / Astro, which require that prefix
    // to expose vars to client code. HEXCLAVE_* names are preferred; the
    // legacy STACK_* / PUBLIC_STACK_* names remain accepted as a fallback.
    { names: ["HEXCLAVE_PROJECT_ID", "PUBLIC_HEXCLAVE_PROJECT_ID", "STACK_PROJECT_ID", "PUBLIC_STACK_PROJECT_ID"], severity: "fail" },
    { names: ["HEXCLAVE_PUBLISHABLE_CLIENT_KEY", "PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY", "STACK_PUBLISHABLE_CLIENT_KEY", "PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY"], severity: "warn" },
    { names: ["HEXCLAVE_SECRET_SERVER_KEY", "STACK_SECRET_SERVER_KEY"], severity: "fail" },
  ]),
  configFileCheck(),
];

function packageInstalledCheck(id: string, packageName: string): CheckSpec {
  const label = `${packageName} installed`;
  return {
    id,
    label,
    run: (ctx) => {
      const allDeps = {
        ...(ctx.packageJson.dependencies ?? {}),
        ...(ctx.packageJson.devDependencies ?? {}),
      };
      if (allDeps[packageName]) {
        return { id, label, status: "pass" };
      }
      return {
        id,
        label,
        status: "fail",
        detail: `${packageName} is not in dependencies or devDependencies.`,
        hint: `Install it: npm install ${packageName} (or pnpm/yarn/bun equivalent).`,
      };
    },
  };
}

function fileExistsCheck(id: string, label: string, candidates: string[], extraHint?: string): CheckSpec {
  return {
    id,
    label,
    run: (ctx) => {
      const resolved = candidates.map((c) => `${ctx.srcPrefix}${c}`);
      for (const rel of resolved) {
        if (fs.existsSync(path.join(ctx.projectDir, rel))) {
          return {
            id,
            label: `${label} found (${rel})`,
            status: "pass",
          };
        }
      }
      return {
        id,
        label: `${label} missing`,
        status: "fail",
        detail: `Expected one of: ${resolved.join(", ")}`,
        hint: extraHint,
      };
    },
  };
}

function layoutWrapsStackProviderCheck(): CheckSpec {
  const id = "next.layout-provider";
  const label = "Root layout wraps children in <HexclaveProvider>";
  const baseCandidates = [
    "app/layout.tsx", "app/layout.jsx", "app/layout.ts", "app/layout.js",
  ];
  return {
    id,
    label,
    run: (ctx) => {
      const candidates = baseCandidates.map((c) => `${ctx.srcPrefix}${c}`);
      let foundPath: string | null = null;
      for (const candidate of candidates) {
        const full = path.join(ctx.projectDir, candidate);
        if (fs.existsSync(full)) {
          foundPath = full;
          break;
        }
      }
      if (!foundPath) {
        return {
          id,
          label: "Root layout missing",
          status: "fail",
          detail: `Expected one of: ${candidates.join(", ")}`,
        };
      }

      const content = fs.readFileSync(foundPath, "utf-8");
      // Accept the Hexclave provider first and the legacy StackProvider alias
      // so doctor works for newly generated and pre-rebrand projects.
      const importsProvider =
        /import\s*\{[^}]*\b(?:HexclaveProvider|StackProvider)\b[^}]*\}\s*from\s*["'](?:@hexclave\/next|@stackframe\/stack)["']/.test(content);
      const wrapsJsx = /<(?:HexclaveProvider|StackProvider)\b/.test(content);

      const rel = path.relative(ctx.projectDir, foundPath);
      if (importsProvider && wrapsJsx) {
        return { id, label, status: "pass" };
      }
      if (importsProvider && !wrapsJsx) {
        return {
          id,
          label,
          status: "warn",
          detail: `${rel} imports HexclaveProvider from @hexclave/next but does not render it.`,
          hint: "Wrap {children} with <HexclaveProvider app={hexclaveClientApp}>...</HexclaveProvider>.",
        };
      }
      if (!importsProvider && wrapsJsx) {
        return {
          id,
          label,
          status: "fail",
          detail: `${rel} renders <HexclaveProvider> but is missing the import from @hexclave/next.`,
          hint: `Add: import { HexclaveProvider } from "@hexclave/next";`,
        };
      }
      return {
        id,
        label,
        status: "fail",
        detail: `${rel} does not import HexclaveProvider from @hexclave/next.`,
        hint: `Add: import { HexclaveProvider } from "@hexclave/next"; and wrap {children} with <HexclaveProvider app={hexclaveClientApp}>...</HexclaveProvider>.`,
      };
    },
  };
}

type EnvVarSpec = {
  names: string[],
  severity: "fail" | "warn",
};

function envVarsCheck(specs: EnvVarSpec[]): CheckSpec {
  return {
    id: "env-vars",
    label: `Required env vars (${specs.length})`,
    run: (ctx) => {
      const fromFiles = readEnvFiles(ctx.projectDir);
      const missingHard: string[] = [];
      const missingSoft: string[] = [];
      for (const spec of specs) {
        const present = spec.names.some((n) => {
          const v = fromFiles.has(n) ? fromFiles.get(n)! : (process.env[n] ?? "");
          return v.trim().length > 0;
        });
        if (!present) {
          const display = spec.names.length === 1 ? spec.names[0] : spec.names.join(" / ");
          if (spec.severity === "fail") missingHard.push(display);
          else missingSoft.push(display);
        }
      }
      if (missingHard.length === 0 && missingSoft.length === 0) {
        return { id: "env-vars", label: "Env vars present", status: "pass" };
      }
      if (missingHard.length === 0) {
        return {
          id: "env-vars",
          label: `Missing recommended env vars: ${missingSoft.join(", ")}`,
          status: "warn",
          detail: "Looked in .env.local, .env, and process.env. These may be required depending on dashboard settings (e.g. \"require publishable client keys\").",
          hint: "Set them in .env.local if your project requires them.",
        };
      }
      return {
        id: "env-vars",
        label: `Missing env vars: ${missingHard.join(", ")}`,
        status: "fail",
        detail: missingSoft.length > 0
          ? `Looked in .env.local, .env, and process.env. Also missing (may be required depending on dashboard settings): ${missingSoft.join(", ")}.`
          : "Looked in .env.local, .env, and process.env.",
        hint: "Set the missing variables in .env.local (do not commit secrets).",
      };
    },
  };
}

function configFileCheck(): CheckSpec {
  const id = "config-file";
  const label = "hexclave.config validity";
  const candidates = ["hexclave.config.ts", "hexclave.config.js", "stack.config.ts", "stack.config.js"];
  return {
    id,
    label,
    run: async (ctx) => {
      let foundPath: string | null = null;
      let foundRel: string | null = null;
      for (const c of candidates) {
        const full = path.join(ctx.projectDir, c);
        if (fs.existsSync(full)) {
          foundPath = full;
          foundRel = c;
          break;
        }
      }
      if (!foundPath || !foundRel) return null; // skip — config file is optional

      try {
        const { createConfigFileJiti } = await import("../lib/config-jiti.js");
        const jiti = createConfigFileJiti();
        const mod = await jiti.import<{ config?: unknown }>(foundPath);
        const config = mod.config;
        if (config === undefined) {
          return {
            id,
            label: `${foundRel} is missing a \`config\` export`,
            status: "fail",
            detail: "The file loaded but has no `config` named export.",
            hint: "Add: export const config = { /* ... */ };",
          };
        }
        if (config === null || typeof config !== "object" || Array.isArray(config) || !isPlainObject(config)) {
          return {
            id,
            label: `${foundRel} \`config\` export is not a plain object`,
            status: "fail",
            detail: `Expected a plain object literal, got ${describeValue(config)}.`,
            hint: "Use: export const config = { apps: { installed: { ... } } };",
          };
        }
        return { id, label: `${foundRel} loads and exports a valid config`, status: "pass" };
      } catch (error: unknown) {
        return {
          id,
          label: `${foundRel} failed to load`,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
          hint: "Fix the syntax / imports in your config file.",
        };
      }
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function readEnvFiles(projectDir: string): Map<string, string> {
  const files = [".env.local", ".env"];
  const result = new Map<string, string>();
  for (const f of files) {
    const full = path.join(projectDir, f);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      let key = trimmed.slice(0, eq).trim();
      if (key.startsWith("export ")) key = key.slice("export ".length).trim();
      const rawValue = trimmed.slice(eq + 1).trimStart();
      let value: string;
      const quote = rawValue.startsWith("\"") ? "\"" : rawValue.startsWith("'") ? "'" : null;
      if (quote) {
        const end = rawValue.indexOf(quote, 1);
        value = end > 0 ? rawValue.slice(1, end) : rawValue.slice(1);
      } else {
        const commentIdx = rawValue.search(/\s#/);
        value = (commentIdx >= 0 ? rawValue.slice(0, commentIdx) : rawValue).trimEnd();
      }
      if (!result.has(key)) result.set(key, value);
    }
  }
  return result;
}

function renderHuman(report: Report) {
  const useColor = process.stdout.isTTY;
  const green = useColor ? "\x1b[32m" : "";
  const red = useColor ? "\x1b[31m" : "";
  const yellow = useColor ? "\x1b[33m" : "";
  const dim = useColor ? "\x1b[2m" : "";
  const reset = useColor ? "\x1b[0m" : "";

  const frameworkName =
    report.framework === "next" ? "Next.js" :
      report.framework === "react" ? "React" :
        "JS / Node";

  console.log(`\nHexclave doctor — ${frameworkName} project at ${report.projectDir}\n`);

  for (const r of report.checks) {
    const icon =
      r.status === "pass" ? `${green}✔${reset}` :
        r.status === "warn" ? `${yellow}⚠${reset}` :
      `${red}✘${reset}`;
    console.log(`${icon} ${r.label}`);
    if (r.detail) console.log(`  ${dim}${r.detail}${reset}`);
    if (r.hint) console.log(`  ${dim}Hint: ${r.hint}${reset}`);
  }

  console.log();
  const summary = `${report.passed} passed, ${report.failed} failed${report.warned > 0 ? `, ${report.warned} warned` : ""}.`;
  console.log(summary);
  if (report.failed > 0) {
    console.log(`${dim}Tip: run \`hexclave fix\` and paste the runtime error to apply fixes automatically.${reset}`);
  }
}

export type { CheckResult, Report };
