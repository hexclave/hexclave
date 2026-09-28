import { sentryRollupPlugin } from "@sentry/rollup-plugin";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Rolldown, type UserConfig } from "tsdown";
// @ts-expect-error - this is a workspace tsdown helper imported from source.
import { createBasePlugin } from "../../configs/tsdown/plugins.ts";
// @ts-expect-error - the explicit .ts extension is required when Node loads this config directly.
import { backendRuntimeExternalPackages, isBackendRuntimeExternalPackage } from "./scripts/runtime-external-packages.ts";
// @ts-expect-error - the explicit .ts extension is required because tsdown loads this config via Node's
// native ESM loader (type stripping), which doesn't resolve extensionless relative imports. Locally the
// tsx fallback loader masks this, but CI/Vercel (Node 24) fail with "Cannot find module" without it.
import { getSentryRelease } from "./src/sentry-release.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendDir = __dirname;

const packageJson = JSON.parse(readFileSync(resolve(backendDir, "package.json"), "utf-8"));

const nodeBuiltins = builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]);

const customNoExternal = new Set([
  ...Object.keys(packageJson.dependencies).filter((dep) => !isBackendRuntimeExternalPackage(dep)),
]);

function packageNameFromSpecifier(specifier: string) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function shouldBundleDependency(specifier: string) {
  return customNoExternal.has(packageNameFromSpecifier(specifier));
}

const basePlugin: Rolldown.Plugin = createBasePlugin({});
const sentryRelease = getSentryRelease({
  packageName: packageJson.name,
  packageVersion: packageJson.version,
});
const shouldUploadSourcemaps = process.env.SENTRY_ORG != null
  && process.env.SENTRY_PROJECT != null
  && process.env.SENTRY_AUTH_TOKEN != null;
const plugins = [
  basePlugin,
  ...(shouldUploadSourcemaps ? [
    sentryRollupPlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: sentryRelease,
      },
      sourcemaps: {
        // Debug ID upload needs each deployed JavaScript artifact together
        // with its source map. Supplying only maps produces "Didn't find any
        // matching sources" even though tsdown generated the maps correctly.
        assets: [
          resolve(backendDir, "dist/**/*.mjs"),
          resolve(backendDir, "dist/**/*.mjs.map"),
        ],
      },
    }),
  ] : []),
];

export default defineConfig({
  entry: [
    resolve(backendDir, "src/server/server.ts"),
    resolve(backendDir, "src/server/vercel.ts"),
  ],
  format: ["esm"],
  outDir: resolve(backendDir, "dist"),
  target: "node24",
  platform: "node",
  noExternal: shouldBundleDependency,
  inlineOnly: false,
  external: [...nodeBuiltins, ...backendRuntimeExternalPackages],
  clean: true,
  minify: false,
  sourcemap: true,
  alias: {
    "@": resolve(backendDir, "src"),
  },
  banner: {
    js: `import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
const require = __createRequire(import.meta.url);`,
  },
  plugins,
} satisfies UserConfig);
