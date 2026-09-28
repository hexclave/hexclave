import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "tsdown";

const marshalDir = dirname(fileURLToPath(import.meta.url));

const nodeBuiltins = builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]);

// Marshal has no workspace dependencies, so bundling is only about producing one artifact the
// host can load without resolving a pnpm store layout — with these exceptions:
//
// @aws-sdk and @smithy use complex class hierarchies that rolldown mis-scopes when bundled,
// emitting references to hoisted classes before they're defined. Keep them external so Node
// resolves them from node_modules at runtime, which is always present alongside the bundle
// (CI runner, Vercel's NFT trace). Mirrors apps/backend/scripts/runtime-external-packages.ts.
const runtimeExternalPackages = ["@aws-sdk", "@smithy"];

function packageNameFromSpecifier(specifier: string) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function shouldBundleDependency(specifier: string) {
  const packageName = packageNameFromSpecifier(specifier);
  return !runtimeExternalPackages.some((external) => packageName === external || packageName.startsWith(`${external}/`));
}

export default defineConfig({
  entry: [
    // The listener entry is built too, so the bundle that a container/host runs is the same
    // artifact CI produces rather than a second, unbuilt code path.
    resolve(marshalDir, "src/server.ts"),
    resolve(marshalDir, "src/vercel.ts"),
  ],
  format: ["esm"],
  outDir: resolve(marshalDir, "dist"),
  target: "node22",
  platform: "node",
  noExternal: shouldBundleDependency,
  inlineOnly: false,
  external: [...nodeBuiltins, ...runtimeExternalPackages],
  clean: true,
  minify: false,
  sourcemap: true,
  banner: {
    js: `import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
const require = __createRequire(import.meta.url);`,
  },
} satisfies UserConfig);
