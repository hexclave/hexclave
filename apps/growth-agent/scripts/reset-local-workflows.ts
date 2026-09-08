#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedPackageName = "@hexclave/growth-agent";

export async function resetLocalWorkflows(appRoot: string) {
  const resolvedAppRoot = path.resolve(appRoot);
  const packageJsonPath = path.join(resolvedAppRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== expectedPackageName) {
    throw new Error(
      `Refusing to reset Eve workflows outside ${expectedPackageName}; found ${JSON.stringify(packageJson.name)} at ${packageJsonPath}`,
    );
  }

  const eveDirectory = path.join(resolvedAppRoot, ".eve");
  const workflowDataDirectory = path.join(eveDirectory, ".workflow-data");
  if (path.dirname(workflowDataDirectory) !== eveDirectory) {
    throw new Error(`Refusing to reset an unexpected workflow data path: ${workflowDataDirectory}`);
  }

  await rm(workflowDataDirectory, { recursive: true, force: true });
  return workflowDataDirectory;
}

const scriptPath = process.argv[1] == null ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (scriptPath === import.meta.url) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const resetPath = await resetLocalWorkflows(appRoot);
  console.log(`[growth-agent] Cleared previous local Eve sessions from ${resetPath}`);
}
