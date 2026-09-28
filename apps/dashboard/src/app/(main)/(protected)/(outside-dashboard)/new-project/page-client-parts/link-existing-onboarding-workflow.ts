export const WORKFLOW_FILE_NAME = "hexclave-config-sync.yml";
export const WORKFLOW_FILE_PATH = `.github/workflows/${WORKFLOW_FILE_NAME}`;
export const GITHUB_PROJECT_ID_SECRET_NAME = "HEXCLAVE_PROJECT_ID";
export const GITHUB_SECRET_SERVER_KEY_SECRET_NAME = "HEXCLAVE_SECRET_SERVER_KEY";
export const EXAMPLE_WORKFLOW_BRANCH = "main";
export const EXAMPLE_WORKFLOW_CONFIG_PATH = "hexclave.config.ts";

/**
 * Prompt for a coding agent to author the GitHub Actions config-sync workflow.
 * Deliberately omits branch/config-path inputs — the agent should inspect the repo.
 * `reminders` should be the standard Hexclave reminders block (docs URLs already swapped).
 */
export function buildGithubWorkflowAiPrompt(options: { reminders: string }): string {
  const exampleWorkflowYaml = buildWorkflowYaml(EXAMPLE_WORKFLOW_BRANCH, EXAMPLE_WORKFLOW_CONFIG_PATH);

  return `Create a GitHub Actions workflow that syncs this repository's Hexclave config to Hexclave cloud whenever the config changes.

Requirements:
1. Save the workflow at \`${WORKFLOW_FILE_PATH}\` (or another sensible path under \`.github/workflows/\`).
2. Trigger on \`workflow_dispatch\` and on \`push\` when the Hexclave config file or the workflow file itself changes.
3. Inspect this repository and figure out the correct default branch and Hexclave config file path yourself (common names include \`hexclave.config.ts\` or \`stack.config.ts\`). Do not ask me for those values.
4. The job should:
   - Check out the repository
   - Set up Node.js 24
   - Install dependencies using the repo's package manager (detect from the lockfile: pnpm, yarn, bun, or npm)
   - Run: \`npx --yes @hexclave/cli@latest config push --config-file "$HEXCLAVE_CONFIG_PATH" --source github --source-repo "$HEXCLAVE_SOURCE_REPO" --source-path "$HEXCLAVE_CONFIG_PATH" --source-workflow-path "$HEXCLAVE_SOURCE_WORKFLOW_PATH"\`
5. Pass these environment variables into the push step:
   - \`HEXCLAVE_PROJECT_ID\`: \${{ secrets.${GITHUB_PROJECT_ID_SECRET_NAME} }}
   - \`HEXCLAVE_SECRET_SERVER_KEY\`: \${{ secrets.${GITHUB_SECRET_SERVER_KEY_SECRET_NAME} }}
   - \`HEXCLAVE_CONFIG_PATH\`: the config file path you determined
   - \`HEXCLAVE_SOURCE_REPO\`: \${{ github.repository }}
   - \`HEXCLAVE_SOURCE_WORKFLOW_PATH\`: the workflow file path you chose

Here is an example workflow. Adapt the branch (\`${EXAMPLE_WORKFLOW_BRANCH}\`) and config path (\`${EXAMPLE_WORKFLOW_CONFIG_PATH}\`) to this repository — do not copy the placeholders blindly:

\`\`\`yaml
${exampleWorkflowYaml}
\`\`\`

Create or update the workflow file in the repo and commit it.

${options.reminders}`;
}

function encodeYamlScalar(value: string): string {
  return JSON.stringify(value);
}

// GitHub Actions `on.push.paths` filters are repo-relative and do not match a
// leading `./` or `/`. Config-path suggestions and manual input may include
// either, possibly repeated (e.g. `.//src/...`), so strip any combination of
// leading `./` and `/` segments to keep the push trigger and checked-out path
// canonical.
export function normalizeConfigPath(configPath: string): string {
  return configPath.trim().replace(/^(?:\.?\/+)+/, "");
}

export function buildWorkflowYaml(branch: string, configPath: string): string {
  const encodedBranch = encodeYamlScalar(branch);
  const normalizedConfigPath = normalizeConfigPath(configPath);
  if (normalizedConfigPath.length === 0) {
    throw new Error("Expected a non-empty config path after normalization (input must not be blank or only './').");
  }
  const encodedConfigPath = encodeYamlScalar(normalizedConfigPath);
  const encodedWorkflowPath = encodeYamlScalar(WORKFLOW_FILE_PATH);

  // `actions/checkout` lands the repo at the runner cwd, so `$STACK_AUTH_CONFIG_PATH`
  // (repo-relative) is also the local path on disk — that's why the same env var is
  // safe to use for both `--config-file` and `--source-path`. If a future workflow
  // checks out with `with: path: <subdir>`, these would diverge.
  return `name: Hexclave Config Sync

on:
  workflow_dispatch:
  push:
    branches:
      - ${encodedBranch}
    paths:
      - ${encodedConfigPath}
      - ${encodedWorkflowPath}

jobs:
  push-hexclave-config:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "24"
      # Install the repo's dependencies so the config file's SDK import (e.g.
      # \`@hexclave/js\`) — and any other package it imports — resolves when the
      # CLI evaluates it. The package manager is detected from the lockfile.
      - name: Install dependencies
        run: |
          if [ -f pnpm-lock.yaml ]; then
            corepack enable
            pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then
            corepack enable
            yarn install --immutable
          elif [ -f bun.lockb ] || [ -f bun.lock ]; then
            npm install -g bun
            bun install --frozen-lockfile
          elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
            npm ci
          elif [ -f package.json ]; then
            npm install
          else
            echo "No package.json found at the repository root; skipping dependency install."
          fi
      - name: Push Hexclave config
        env:
          HEXCLAVE_PROJECT_ID: \${{ secrets.${GITHUB_PROJECT_ID_SECRET_NAME} }}
          HEXCLAVE_SECRET_SERVER_KEY: \${{ secrets.${GITHUB_SECRET_SERVER_KEY_SECRET_NAME} }}
          HEXCLAVE_CONFIG_PATH: ${encodedConfigPath}
          HEXCLAVE_SOURCE_REPO: \${{ github.repository }}
          HEXCLAVE_SOURCE_WORKFLOW_PATH: ${encodedWorkflowPath}
        run: npx --yes @hexclave/cli@latest config push --config-file "$HEXCLAVE_CONFIG_PATH" --source github --source-repo "$HEXCLAVE_SOURCE_REPO" --source-path "$HEXCLAVE_CONFIG_PATH" --source-workflow-path "$HEXCLAVE_SOURCE_WORKFLOW_PATH"
`;
}
