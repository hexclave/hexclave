import fs from 'fs';
import { dirname, join, resolve } from 'node:path';
import type { Rolldown } from 'tsdown';

const SOURCE_FILE_PATTERN = /\.(jsx?|tsx?)$/;
const USE_CLIENT_DIRECTIVE_PATTERN = /["']use\s+client["']/i;
const USE_CLIENT_AT_TOP_PATTERN = /^\s*["']use\s+client["']\s*;?/;
const CLIENT_VERSION_SENTINEL = 'STACK_COMPILE_TIME_CLIENT_PACKAGE_VERSION_SENTINEL';

function findNearestPackageJson(cwd: string): string {
  let currentDirectory = resolve(cwd);

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not find a package.json from tsdown cwd ${cwd} up to the filesystem root.`);
    }
    currentDirectory = parentDirectory;
  }
}

export const createBasePlugin = (_options: {}): Rolldown.Plugin => {
  let packageVersionLabel: string | undefined;

  return {
    name: 'stackframe tsdown plugin (private)',
    buildStart({ cwd }: Rolldown.NormalizedInputOptions) {
      // Workspace builds run tsdown from the monorepo root, so the process's cwd would stamp every
      // package with the root package.json. Rolldown's per-config cwd may be nested below the
      // package root, so resolve the nearest package.json instead.
      const packageJsonPath = findNearestPackageJson(cwd);
      const { name, version }: { name?: unknown, version?: unknown } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (typeof name !== 'string' || typeof version !== 'string') {
        throw new Error(`Expected ${packageJsonPath} to have a string name and version.`);
      }
      packageVersionLabel = `js ${name}@${version}`;
    },
    transform(code: string, id: string) {
      if (!SOURCE_FILE_PATTERN.test(id)) {
        return null;
      }

      let transformedCode = code;
      if (code.includes(CLIENT_VERSION_SENTINEL)) {
        if (packageVersionLabel == null) {
          throw new Error('Expected tsdown buildStart to resolve the package version before transform.');
        }
        transformedCode = transformedCode.replaceAll(CLIENT_VERSION_SENTINEL, packageVersionLabel);
      }
      transformedCode = transformedCode.replace(/import\.meta\.vitest/g, 'undefined');

      if (USE_CLIENT_DIRECTIVE_PATTERN.test(transformedCode) && !USE_CLIENT_AT_TOP_PATTERN.test(transformedCode)) {
        transformedCode = `"use client";\n${transformedCode}`;
      }

      if (transformedCode === code) {
        return null;
      }

      return {
        code: transformedCode,
        map: null,
      };
    },
  };
};
