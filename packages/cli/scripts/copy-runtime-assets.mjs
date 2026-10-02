#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { completeStandaloneSwcHelpers } from "../../../apps/dashboard/scripts/complete-standalone-swc-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const dashboardRoot = resolve(repoRoot, "apps/dashboard");
const dashboardStandaloneSrc = join(dashboardRoot, ".next/standalone");
const dashboardStaticSrc = join(dashboardRoot, ".next/static");
const dashboardPublicSrc = join(dashboardRoot, "public");
const distDir = join(packageRoot, "dist");
const dashboardDist = join(distDir, "dashboard");

function assertExists(path, message) {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

function shouldCopyDashboardFile(path) {
  return existsSync(path);
}

function copyDashboardSymlinkTarget(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, dereference: true, filter: shouldCopyDashboardFile });
}

function splitDashboardPath(root, path) {
  return relative(root, path).split(/[\\/]+/);
}

function getDashboardDependencyName(pnpmRoot, path) {
  const parts = splitDashboardPath(pnpmRoot, path);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0) {
    return undefined;
  }
  const dependencyParts = parts.slice(nodeModulesIndex + 1);
  if (dependencyParts.length === 1) {
    return dependencyParts[0];
  }
  if (dependencyParts.length === 2 && dependencyParts[0].startsWith("@")) {
    return join(dependencyParts[0], dependencyParts[1]);
  }
  return undefined;
}

function copyDashboardHoistedDependencies(pnpmRoot, current = pnpmRoot) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      copyDashboardHoistedDependencies(pnpmRoot, path);
      continue;
    }
    if (!entry.isSymbolicLink() || !existsSync(path)) {
      continue;
    }
    const dependencyName = getDashboardDependencyName(pnpmRoot, path);
    if (dependencyName == null) {
      continue;
    }
    const target = resolve(current, readlinkSync(path));
    const parts = splitDashboardPath(pnpmRoot, path);
    if (parts[0] !== "node_modules" && existsSync(join(target, "package.json"))) {
      copyDashboardSymlinkTarget(target, join(dashboardDist, "node_modules", dependencyName));
    }
  }
}

// Packages that are only needed at build time or are unnecessary in the
// standalone runtime. These are pulled in by file tracing (e.g. via jiti/next)
// but are never loaded during production server execution.
// sharp and its native bindings (@img/*) are excluded because the RDE
// standalone build sets images.unoptimized=true.
const EXCLUDED_RUNTIME_PACKAGES = new Set([
  "typescript",
  "sharp",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-linux-x64",
  "@img/colour",
]);

// Packages whose staged copy must be the complete published package rather
// than the file-traced subset. Next's trace resolves @swc/helpers subpath
// exports to the cjs/ files, but Node runtimes with require(esm) match the
// "module-sync"/"import" conditions first and load the esm/ files, so a
// traced (partial) copy crashes the dashboard server at startup with
// MODULE_NOT_FOUND on @swc/helpers/esm/*.js.
const FULLY_COPIED_RUNTIME_PACKAGES = ["@swc/helpers"];

function findWorkspaceStorePackageDir(packageName, version) {
  const pnpmDir = join(repoRoot, "node_modules/.pnpm");
  if (!existsSync(pnpmDir)) {
    return undefined;
  }
  const prefix = `${packageName.replace("/", "+")}@${version}`;
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== prefix && !entry.name.startsWith(`${prefix}_`))) {
      continue;
    }
    const candidate = join(pnpmDir, entry.name, "node_modules", ...packageName.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return undefined;
}

function completeTracedPackages(nodeModulesDir) {
  for (const packageName of FULLY_COPIED_RUNTIME_PACKAGES) {
    const stagedDir = join(nodeModulesDir, ...packageName.split("/"));
    const stagedPackageJsonPath = join(stagedDir, "package.json");
    if (!existsSync(stagedPackageJsonPath)) {
      continue;
    }
    const version = JSON.parse(readFileSync(stagedPackageJsonPath, "utf8")).version;
    const source = findWorkspaceStorePackageDir(packageName, version);
    if (source == null) {
      throw new Error(`Could not find ${packageName}@${version} in the workspace pnpm store to complete the staged runtime copy.`);
    }
    cpSync(source, stagedDir, { recursive: true, dereference: true });
  }
}

function hoistPnpmNodeModules(pnpmDir) {
  // The pnpm store keeps a shared `node_modules/` directory for hoisted
  // packages that peer-dep symlinks resolve through. After we dereference all
  // symlinks, these packages must also be available at the top-level
  // `node_modules/` so that Node.js module resolution finds them.
  const sharedNodeModules = join(pnpmDir, "node_modules");
  if (!existsSync(sharedNodeModules)) {
    return;
  }
  const destNodeModules = dirname(pnpmDir);
  for (const entry of readdirSync(sharedNodeModules, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) {
      continue;
    }
    if (name.startsWith("@")) {
      // Scoped package — iterate one level deeper
      const scopeDir = join(sharedNodeModules, name);
      for (const scopedEntry of readdirSync(scopeDir, { withFileTypes: true })) {
        const fullName = join(name, scopedEntry.name);
        if (EXCLUDED_RUNTIME_PACKAGES.has(fullName)) {
          continue;
        }
        const dest = join(destNodeModules, fullName);
        if (!existsSync(dest)) {
          cpSync(join(scopeDir, scopedEntry.name), dest, { recursive: true, dereference: true });
        }
      }
    } else {
      if (EXCLUDED_RUNTIME_PACKAGES.has(name)) {
        continue;
      }
      const dest = join(destNodeModules, name);
      if (!existsSync(dest)) {
        cpSync(join(sharedNodeModules, name), dest, { recursive: true, dereference: true });
      }
    }
  }
}

function getPackageNameFromPnpmSpecifier(specifier) {
  // Extract the package name from a pnpm store specifier directory name.
  // e.g. "@anthropic-ai+claude-agent-sdk@0.2.73_zod@4.3.6" → "@anthropic-ai/claude-agent-sdk"
  // e.g. "react@19.2.3" → "react"
  const atVersionIndex = specifier.indexOf("@", specifier.startsWith("@") ? 1 : 0);
  if (atVersionIndex < 0) {
    return undefined;
  }
  const nameWithPlus = specifier.slice(0, atVersionIndex);
  if (nameWithPlus.startsWith("@")) {
    const plusIndex = nameWithPlus.indexOf("+");
    if (plusIndex >= 0) {
      return nameWithPlus.slice(0, plusIndex) + "/" + nameWithPlus.slice(plusIndex + 1);
    }
  }
  return nameWithPlus;
}

function getMaterializedStandalonePackageNames(nextNodeModulesDir) {
  const packageNames = new Set();
  if (!existsSync(nextNodeModulesDir)) {
    return packageNames;
  }

  for (const scopeEntry of readdirSync(nextNodeModulesDir, { withFileTypes: true })) {
    const scopePath = join(nextNodeModulesDir, scopeEntry.name);
    const packageEntries = scopeEntry.name.startsWith("@") && scopeEntry.isDirectory()
      ? readdirSync(scopePath, { withFileTypes: true }).map((entry) => ({
          entry,
          packagePath: join(scopePath, entry.name),
          packageName: join(scopeEntry.name, entry.name),
        }))
      : [{ entry: scopeEntry, packagePath: scopePath, packageName: scopeEntry.name }];

    for (const { entry, packagePath, packageName } of packageEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = join(packagePath, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const declaredPackageName = JSON.parse(readFileSync(packageJsonPath, "utf8")).name;
      const directoryName = packageName.split("/").at(-1);
      const declaredName = typeof declaredPackageName === "string"
        ? declaredPackageName.split("/").at(-1)
        : undefined;
      if (
        typeof declaredPackageName === "string" &&
        declaredName != null &&
        directoryName !== declaredName &&
        directoryName.startsWith(`${declaredName}-`)
      ) {
        packageNames.add(declaredPackageName);
      }
    }
  }

  return packageNames;
}

function hoistPnpmStorePackages(pnpmDir, materializedPackageNames) {
  // Each .pnpm/<specifier>/node_modules/<name>/ contains the primary package
  // for that specifier. When serverExternalPackages are used, these directories
  // hold the actual module files (including non-imported assets like cli.js)
  // that Node.js needs to resolve at runtime. Hoist them to the top-level
  // node_modules/ so they survive .pnpm removal.
  const destNodeModules = dirname(pnpmDir);
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const packageName = getPackageNameFromPnpmSpecifier(entry.name);
    if (
      packageName == null ||
      EXCLUDED_RUNTIME_PACKAGES.has(packageName) ||
      materializedPackageNames.has(packageName)
    ) {
      continue;
    }
    const packageDir = join(pnpmDir, entry.name, "node_modules", ...packageName.split("/"));
    if (!existsSync(packageDir) || !existsSync(join(packageDir, "package.json"))) {
      continue;
    }
    const dest = join(destNodeModules, packageName);
    if (!existsSync(dest)) {
      const scopeDir = packageName.includes("/") ? join(destNodeModules, packageName.split("/")[0]) : null;
      if (scopeDir && !existsSync(scopeDir)) {
        mkdirSync(scopeDir, { recursive: true });
      }
      cpSync(packageDir, dest, { recursive: true, dereference: true });
    }
  }
}

function removePnpmStore(nodeModulesDir, materializedPackageNames) {
  const pnpmDir = join(nodeModulesDir, ".pnpm");
  if (!existsSync(pnpmDir)) {
    return;
  }
  hoistPnpmNodeModules(pnpmDir);
  hoistPnpmStorePackages(pnpmDir, materializedPackageNames);
  rmSync(pnpmDir, { recursive: true, force: true });
}

function removeExcludedPackages(nodeModulesDir) {
  for (const pkg of EXCLUDED_RUNTIME_PACKAGES) {
    const pkgPath = join(nodeModulesDir, pkg);
    if (existsSync(pkgPath)) {
      rmSync(pkgPath, { recursive: true, force: true });
    }
  }
}

function removeNftJsonFiles(dir) {
  // .nft.json files are Next.js file-trace manifests used only during the build
  // to determine which files to include in standalone output. They are not
  // needed at runtime and add ~4 MB to the package.
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeNftJsonFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
      rmSync(path);
    }
  }
}

function removeMapFiles(dir) {
  // Browser source maps are not needed by the staged runtime. Remove them
  // after copying all assets so generated or public maps cannot leak into the
  // release regardless of which build produced them.
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeMapFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      rmSync(path);
    }
  }
}

function copyDashboardAssets() {
  assertExists(
    join(dashboardStandaloneSrc, "apps/dashboard/server.js"),
    "Dashboard standalone build is missing. Run `pnpm exec turbo run build:rde-standalone --filter=@hexclave/dashboard` before building @hexclave/cli.",
  );
  assertExists(
    dashboardStaticSrc,
    "Dashboard static assets are missing. Run `pnpm exec turbo run build:rde-standalone --filter=@hexclave/dashboard` before building @hexclave/cli.",
  );

  completeStandaloneSwcHelpers(dashboardStandaloneSrc, join(repoRoot, "node_modules", ".pnpm"));

  rmSync(dashboardDist, { recursive: true, force: true });
  cpSync(dashboardStandaloneSrc, dashboardDist, { recursive: true, dereference: true, filter: shouldCopyDashboardFile });
  cpSync(dashboardStaticSrc, join(dashboardDist, "apps/dashboard/.next/static"), { recursive: true });
  if (existsSync(dashboardPublicSrc)) {
    cpSync(dashboardPublicSrc, join(dashboardDist, "apps/dashboard/public"), { recursive: true });
  }
  copyDashboardHoistedDependencies(join(dashboardStandaloneSrc, "node_modules/.pnpm"));

  // Remove the .pnpm store from the output. After cpSync with dereference:true
  // all symlinks are resolved to real files, so the .pnpm directory is entirely
  // duplicate content (~113 MB). We first hoist any shared packages that only
  // exist inside .pnpm/node_modules/ to the top-level node_modules/.
  const dashboardNodeModules = join(dashboardDist, "node_modules");
  const materializedPackageNames = getMaterializedStandalonePackageNames(
    join(dashboardDist, "apps/dashboard/.next/node_modules"),
  );
  // Next aliases external packages as <name>-<hash> under .next/node_modules.
  // Those traced copies already contain the complete package, so hoisting the
  // same package to top-level would create a second copy after .pnpm removal.
  removePnpmStore(dashboardNodeModules, materializedPackageNames);
  removeExcludedPackages(dashboardNodeModules);
  completeTracedPackages(dashboardNodeModules);
  removeNftJsonFiles(join(dashboardDist, "apps/dashboard/.next"));
  removeMapFiles(dashboardDist);

  console.log(`Copied dashboard standalone runtime into ${dashboardDist}.`);
}

copyDashboardAssets();
