import { replaceConfigObject } from "@hexclave/shared-backend";
import { detectImportPackageFromDir } from "@hexclave/shared/dist/config-eval";
import { isValidConfig } from "@hexclave/shared/dist/config/format";
import type { EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { getAdminProject } from "../lib/app.js";
import { isProjectAuthWithRefreshToken, isProjectAuthWithSecretServerKey, resolveAuth, resolveProjectId, type ProjectAuth, type ProjectAuthWithSecretServerKey } from "../lib/auth.js";
import { resolveConfigFilePathOption } from "../lib/config-file-path.js";
import { CliError } from "../lib/errors.js";
import { startProgress, withProgress } from "../lib/progress.js";

const SHOW_ONBOARDING_STACK_CONFIG_VALUE = "show-onboarding";

function isConfigOverride(value: unknown): value is EnvironmentConfigOverrideOverride {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseConfigOverride(value: unknown): EnvironmentConfigOverrideOverride | null {
  if (value === SHOW_ONBOARDING_STACK_CONFIG_VALUE) {
    return {};
  }
  return isConfigOverride(value) ? value : null;
}

export type BranchConfigSourceApi =
  | { type: "pushed-from-github", owner: string, repo: string, branch: string, commit_hash: string, config_file_path: string, workflow_path?: string }
  | { type: "pushed-from-unknown" }
  | { type: "unlinked" };

type SourceFlagOptions = {
  source?: string,
  sourceRepo?: string,
  sourcePath?: string,
  sourceWorkflowPath?: string,
};

const OWNER_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

function parseOwnerRepo(value: string, flagName: string): { owner: string, repo: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !OWNER_REPO_SEGMENT.test(parts[0]) || !OWNER_REPO_SEGMENT.test(parts[1])) {
    throw new CliError(`${flagName} must be in the format 'owner/repo' using only letters, digits, '.', '_' or '-' (got '${value}').`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function parseGitHubRepositoryEnv(): { owner: string, repo: string } | null {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    return null;
  }
  try {
    return parseOwnerRepo(repository, "GITHUB_REPOSITORY");
  } catch {
    return null;
  }
}

function normalizeRepoRelativePath(value: string, flagName: string): string {
  const normalized = value.trim().replace(/^(?:\.?\/+)+/, "");
  if (normalized.length === 0) {
    throw new CliError(`${flagName} must be a non-empty repo-relative path string.`);
  }
  return normalized;
}

export function buildConfigPushSource(configFilePath: string, flags: SourceFlagOptions): BranchConfigSourceApi {
  const dependentFlags: Array<[string, string | undefined]> = [
    ["--source-repo", flags.sourceRepo],
    ["--source-path", flags.sourcePath],
    ["--source-workflow-path", flags.sourceWorkflowPath],
  ];
  const providedDependent = dependentFlags.filter(([, v]) => v !== undefined).map(([k]) => k);

  if (flags.source !== undefined) {
    if (flags.source !== "github") {
      throw new CliError(`Invalid --source value '${flags.source}'. Only 'github' is supported.`);
    }
    const missing = dependentFlags.filter(([, v]) => v === undefined).map(([k]) => k);
    if (missing.length > 0) {
      throw new CliError(`When --source github is specified, the following flags are also required: ${missing.join(", ")}.`);
    }

    const { owner, repo } = parseOwnerRepo(
      flags.sourceRepo ?? throwErr("Expected --source-repo to be provided when --source github is specified; this should have been caught by the missing-flags check."),
      "--source-repo",
    );

    const sourcePath = normalizeRepoRelativePath(
      flags.sourcePath ?? throwErr("Expected --source-path to be provided when --source github is specified; this should have been caught by the missing-flags check."),
      "--source-path",
    );
    const sourceWorkflowPath = normalizeRepoRelativePath(
      flags.sourceWorkflowPath ?? throwErr("Expected --source-workflow-path to be provided when --source github is specified; this should have been caught by the missing-flags check."),
      "--source-workflow-path",
    );

    const sha = process.env.GITHUB_SHA;
    const branch = process.env.GITHUB_REF_NAME;
    if (!sha) {
      throw new CliError("--source github requires the GITHUB_SHA environment variable (commit hash) to be set.");
    }
    if (!branch) {
      throw new CliError("--source github requires the GITHUB_REF_NAME environment variable (branch) to be set.");
    }

    return {
      type: "pushed-from-github",
      owner,
      repo,
      branch,
      commit_hash: sha,
      config_file_path: sourcePath,
      workflow_path: sourceWorkflowPath,
    };
  }

  if (providedDependent.length > 0) {
    throw new CliError(`${providedDependent.join(", ")} can only be used with --source github.`);
  }

  const repository = parseGitHubRepositoryEnv();
  const sha = process.env.GITHUB_SHA;
  const branch = process.env.GITHUB_REF_NAME;

  if (repository && sha && branch) {
    return {
      type: "pushed-from-github",
      owner: repository.owner,
      repo: repository.repo,
      branch,
      commit_hash: sha,
      config_file_path: configFilePath,
    };
  }

  return { type: "pushed-from-unknown" };
}

async function pushConfigWithSecretServerKey(
  auth: ProjectAuthWithSecretServerKey,
  config: EnvironmentConfigOverrideOverride,
  source: BranchConfigSourceApi,
) {
  const endpoint = `${auth.apiUrl.replace(/\/$/, "")}/api/v1/internal/config/override/branch`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-stack-project-id": auth.projectId,
      "x-stack-access-type": "server",
      "x-stack-secret-server-key": auth.secretServerKey,
    },
    body: JSON.stringify({
      config_string: JSON.stringify(config),
      source,
    }),
  });

  if (response.ok) {
    return;
  }

  const responseText = await response.text();
  const message = responseText.length > 0
    ? responseText
    : `Request failed with status ${response.status}.`;
  throw new CliError(`Failed to push config with HEXCLAVE_SECRET_SERVER_KEY: ${message}`);
}

/**
 * Pushes a parsed config override to the project's branch config, for
 * `hexclave config push`. Publishing the project's configuration is deliberately
 * its own command: `hexclave deploy` ships this repository's services and never
 * touches the config, so one of several repositories deploying into a project
 * cannot overwrite the others' configuration on the way past.
 */
async function pushConfigToProject(auth: ProjectAuth, config: EnvironmentConfigOverrideOverride, source: BranchConfigSourceApi): Promise<void> {
  if (isProjectAuthWithSecretServerKey(auth)) {
    await pushConfigWithSecretServerKey(auth, config, source);
  } else {
    if (!isProjectAuthWithRefreshToken(auth)) {
      throw new CliError("Pushing the config requires either HEXCLAVE_SECRET_SERVER_KEY or `hexclave login`.");
    }
    const project = await getAdminProject(auth);
    await project.pushConfig(config, {
      source: sourceToSdkSource(source),
    });
  }
}

function sourceToSdkSource(source: BranchConfigSourceApi):
  { type: "pushed-from-github", owner: string, repo: string, branch: string, commitHash: string, configFilePath: string, workflowPath?: string }
  | { type: "pushed-from-unknown" }
  | { type: "unlinked" } {
  if (source.type === "pushed-from-github") {
    return {
      type: "pushed-from-github",
      owner: source.owner,
      repo: source.repo,
      branch: source.branch,
      commitHash: source.commit_hash,
      configFilePath: source.config_file_path,
      workflowPath: source.workflow_path,
    };
  }
  if (source.type === "pushed-from-unknown") {
    return { type: "pushed-from-unknown" };
  }
  return { type: "unlinked" };
}

// Resolve the path for `config pull` when `--config-file` was omitted. Prefer
// an existing config file in cwd, otherwise use the Hexclave default path so a
// prod-to-local pull can create the local config file without extra flags.
export function resolveConfigFilePathForPull(opts: { configFile?: string }, cwd: string): string {
  if (opts.configFile != null && opts.configFile !== "") {
    return resolveConfigFilePathOption(opts.configFile);
  }
  // Hexclave rebrand: prefer the new `hexclave.config.ts` filename, fall back
  // to the legacy `stack.config.ts` so existing projects keep working. If
  // neither exists, create the new filename.
  const hexclaveCandidate = path.join(cwd, "hexclave.config.ts");
  const legacyCandidate = path.join(cwd, "stack.config.ts");
  const candidate = fs.existsSync(hexclaveCandidate) ? hexclaveCandidate : legacyCandidate;
  if (!fs.existsSync(candidate)) {
    return hexclaveCandidate;
  }
  if (fs.statSync(candidate).isDirectory()) {
    throw new CliError(`Default config path points to a directory instead of a file: ${candidate}`);
  }
  return candidate;
}

// `config pull` means "download the entire branch config into a fresh local file". It always writes
// the whole file (via replaceConfigObject) and never edits an existing file in place. In-place,
// hand-authored-preserving edits are the job of the config *update* flow (e.g. from the RDE), which
// routes through updateConfigObject's agent-assisted rewrite — that path is intentionally not
// reachable from `pull`.
//
// Because pull writes the whole file, it would clobber whatever is already at the target path. To
// avoid silently destroying a hand-authored config, we refuse to write over an existing file and
// require the user to opt in explicitly with --overwrite.
export function assertConfigPullTarget(filePath: string, opts: { overwrite?: boolean }): void {
  if (opts.overwrite === true) return;
  if (fs.existsSync(filePath)) {
    throw new CliError(`A config file already exists at ${filePath}. Pass --overwrite to replace it with the pulled config, or remove the file first.`);
  }
}

export function registerConfigCommand(program: Command) {
  const config = program
    .command("config")
    .description("Manage project configuration files");

  config
    .command("pull")
    .description("Pull branch config to a local file")
    .option("--cloud-project-id <id>", "Cloud project ID to pull config from (defaults to the HEXCLAVE_PROJECT_ID env var; STACK_PROJECT_ID is also supported)")
    .option("--config-file <path>", "Path to write config file (.ts); defaults to ./hexclave.config.ts in the current directory")
    .option("--overwrite", "Replace the config file if one already exists at the target path")
    .action(async (opts) => {
      const auth = resolveAuth(resolveProjectId(opts.cloudProjectId));
      if (!isProjectAuthWithRefreshToken(auth)) {
        throw new CliError("`hexclave config pull` requires `hexclave login`. Unset HEXCLAVE_SECRET_SERVER_KEY (or the legacy STACK_SECRET_SERVER_KEY) and try again.");
      }
      // Resolve and validate the target file before any network work so we fail fast (e.g. when the
      // target already exists without --overwrite) instead of paying for a wasted round-trip.
      const filePath = resolveConfigFilePathForPull(opts, process.cwd());
      const ext = path.extname(filePath);
      if (ext !== ".ts") {
        throw new CliError("Config file must have a .ts extension. Typed config files require TypeScript.");
      }
      assertConfigPullTarget(filePath, opts);

      await withProgress("Pulling config", async () => {
        const project = await getAdminProject(auth);
        const configOverride = await project.getConfigOverride("branch");
        if (!isValidConfig(configOverride)) {
          throw new CliError("Pulled branch config is not a valid local config object.");
        }
        await replaceConfigObject(filePath, configOverride);
      });
      console.log(`Config written to ${filePath}`);
    });

  config
    .command("push")
    .description("Push a local config file to branch config")
    .option("--cloud-project-id <id>", "Cloud project ID to push config to (defaults to the HEXCLAVE_PROJECT_ID env var; STACK_PROJECT_ID is also supported)")
    .requiredOption("--config-file <path>", "Path to config file (.js or .ts)")
    .option("--source <type>", "Explicit source type for this push. Only 'github' is supported.")
    .option("--source-repo <owner/repo>", "GitHub repository in 'owner/repo' format. Only allowed with --source github.")
    .option("--source-path <path>", "Path to the config file within the source repository. Only allowed with --source github.")
    .option("--source-workflow-path <path>", "Path to the syncing workflow file within the source repository. Only allowed with --source github.")
    .action(async (opts) => {
      const auth = resolveAuth(resolveProjectId(opts.cloudProjectId));

      const filePath = resolveConfigFilePathOption(opts.configFile, { mustExist: true });
      const ext = path.extname(filePath);

      if (ext !== ".js" && ext !== ".ts") {
        throw new CliError("Config file must have a .js or .ts extension.");
      }

      const source = buildConfigPushSource(opts.configFile, {
        source: opts.source,
        sourceRepo: opts.sourceRepo,
        sourcePath: opts.sourcePath,
        sourceWorkflowPath: opts.sourceWorkflowPath,
      });

      const progress = startProgress("Loading config");
      try {
        // The generated GitHub sync workflow installs the repo's dependencies
        // before running the CLI, so jiti resolves the config's SDK import (e.g.
        // `@hexclave/js`) from the project's own node_modules.
        const { createJiti } = await import("jiti");
        const jiti = createJiti(import.meta.url);
        const configModule: { config?: unknown, deploy?: unknown } = await jiti.import(filePath);

        // Services used to be allowed here. Refused rather than ignored: a
        // silently skipped `deploy` export would leave the author believing
        // their services were published by a command that never looks at them.
        // Keyed on the export EXISTING rather than on its value: `export let
        // deploy;` is still a file whose author thinks it deploys something.
        // (`in` rather than Object.hasOwn: this package targets ES2021.)
        if ("deploy" in configModule) {
          throw new CliError(`${filePath} has a \`deploy\` export. Service definitions no longer live in the config file — move it to a hexclave.deploy.ts (with an \`export const deploymentGroupId = "..."\` naming the deployment group) and ship it with \`hexclave deploy\`, which is a separate command from \`hexclave config push\`.`);
        }

        const config = parseConfigOverride(configModule.config);
        if (config == null) {
          const exampleImport = detectImportPackageFromDir(path.dirname(filePath)) ?? "@hexclave/js";
          throw new CliError(`Config file must export a plain \`config\` object or "show-onboarding". Example: import type { HexclaveConfig } from "${exampleImport}"; export const config: HexclaveConfig = { ... };`);
        }

        progress.update("Pushing config");
        await pushConfigToProject(auth, config, source);
      } finally {
        progress.stop();
      }

      console.log("Config pushed successfully.");
    });
}
