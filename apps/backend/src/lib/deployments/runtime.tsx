// Which infrastructure runtime a project's services run on, and which `version` tokens
// this backend admits.
//
// The runtime is a fact about a deployment SOURCE (the deploy file's `version` export,
// stored on its row by the definitions sync) that every source of a project must agree on:
// services share a private network and resolve each other's addresses, neither of which can
// span providers. See syncSourceServices for the enforcement.
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { DEFAULT_DEPLOYMENT_RUNTIME, DEPLOYMENT_VERSION_TOKENS, deploymentRuntimeForVersion, isDeploymentRuntime, isDeploymentVersion, type DeploymentRuntime, type DeploymentVersion } from "@hexclave/shared/dist/deployments";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

/**
 * The `version` tokens deploys may name here, from HEXCLAVE_DEPLOYMENT_VERSIONS_ENABLED
 * (comma-separated). Unset means none: the token is an internal switch, and an environment
 * whose Marshal has no second runtime configured must refuse it rather than pin a project
 * to a runtime that cannot serve it.
 */
export function enabledDeploymentVersions(): Set<DeploymentVersion> {
  const raw = getEnvVariable("HEXCLAVE_DEPLOYMENT_VERSIONS_ENABLED", "");
  const enabled = new Set<DeploymentVersion>();
  for (const token of raw.split(",").map((value) => value.trim()).filter((value) => value !== "")) {
    if (isDeploymentVersion(token)) enabled.add(token);
  }
  return enabled;
}

/**
 * The runtime a sync request's `version` selects, or a 400.
 *
 * Absent is the default runtime. A token that is not one of ours, or one this environment
 * has not enabled, is refused rather than ignored: silently deploying to the default would
 * hide a typo in our own token, and a stray `version` in a user's deploy file must not mean
 * anything at all. (The CLI refuses unknown tokens first, with a message naming the known
 * ones; this is the boundary that makes it true for every client.)
 */
export function runtimeForRequestedVersion(version: string | undefined): DeploymentRuntime {
  if (version === undefined) return DEFAULT_DEPLOYMENT_RUNTIME;
  const runtime = deploymentRuntimeForVersion(version);
  if (runtime === null) {
    throw new StatusError(400, `Unknown deploy file version ${JSON.stringify(version)}. Remove the \`version\` export, or use one of: ${DEPLOYMENT_VERSION_TOKENS.join(", ")}.`);
  }
  if (!enabledDeploymentVersions().has(version as DeploymentVersion)) {
    throw new StatusError(400, `The deploy file version ${JSON.stringify(version)} is not available in this environment. Remove the \`version\` export to deploy on the default runtime.`);
  }
  return runtime;
}

/** The runtime stored on a source row, defaulting anything unrecognized to the default. */
export function runtimeFromStored(value: string | null | undefined): DeploymentRuntime {
  return isDeploymentRuntime(value) ? value : DEFAULT_DEPLOYMENT_RUNTIME;
}
