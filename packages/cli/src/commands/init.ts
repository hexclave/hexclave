import { StackClientApp } from "@hexclave/js";
import { ALL_APPS, expandAppSoftRequirements, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { detectImportPackageFromDir } from "@hexclave/shared/dist/config-eval";
import { renderConfigFileContent } from "@hexclave/shared/dist/config-rendering";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { getInternalUser } from "../lib/app.js";
import { DEFAULT_PUBLISHABLE_CLIENT_KEY, resolveLoginConfig, resolveSessionAuth } from "../lib/auth.js";
import { runClaudeAgent } from "../lib/claude-agent.js";
import { resolveConfigFilePathOption } from "../lib/config-file-path.js";
import { writeConfigValue } from "../lib/config.js";
import { createProjectInteractively } from "../lib/create-project.js";
import { AuthError, CliError } from "../lib/errors.js";
import { createInitPrompt } from "../lib/init-prompt.js";
import { isNonInteractiveEnv } from "../lib/interactive.js";
import { withProgress } from "../lib/progress.js";

const VALID_INIT_MODES = ["create", "create-cloud", "link-config", "link-cloud"] as const;
type InitMode = typeof VALID_INIT_MODES[number];

type InitOptions = {
  mode?: InitMode,
  apps?: string,
  configFile?: string,
  selectProjectId?: string,
  outputDir?: string,
  agent?: boolean,
  displayName?: string,
};

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize Hexclave in your project")
    .option("--mode <mode>", "Mode: create, create-cloud, link-config, or link-cloud (skips interactive prompts)")
    .option("--apps <apps>", "Comma-separated app IDs to enable (for create mode)")
    .option("--config-file <path>", "Path to existing config file (for link-config mode)")
    .option("--select-project-id <id>", "Project ID to link (for link-cloud mode)")
    .option("--output-dir <dir>", "Directory to write output files (defaults to cwd)")
    .option("--no-agent", "Skip Claude agent and print setup instructions instead")
    .option("--display-name <name>", "Project display name (used by create-cloud mode)")
    .action(async (opts: InitOptions) => {
      if (opts.mode != null && !VALID_INIT_MODES.includes(opts.mode)) {
        throw new CliError(`Invalid --mode: ${opts.mode}. Expected one of: ${VALID_INIT_MODES.join(", ")}.`);
      }
      const hasFlags = opts.mode != null || opts.configFile != null || opts.selectProjectId != null;

      if (!hasFlags && isNonInteractiveEnv()) {
        throw new CliError("hexclave init requires an interactive terminal. Use --mode flag for non-interactive usage.");
      }

      try {
        await runInit(program, opts);
      } catch (error: unknown) {
        if (error != null && typeof error === "object" && "name" in error && error.name === "ExitPromptError") {
          console.log("\nAborted.");
          process.exit(0);
        }
        throw error;
      }
    });
}

function validateOptions(opts: InitOptions) {
  if (opts.selectProjectId && opts.configFile) {
    throw new CliError("--select-project-id and --config-file cannot be used together.");
  }

  const incompatible: Record<NonNullable<InitOptions["mode"]>, Array<keyof InitOptions>> = {
    "create": ["selectProjectId", "configFile"],
    "create-cloud": ["selectProjectId", "configFile", "apps"],
    "link-config": ["selectProjectId", "apps"],
    "link-cloud": ["configFile", "apps"],
  };
  const flagNames: Partial<Record<keyof InitOptions, string>> = {
    selectProjectId: "--select-project-id",
    configFile: "--config-file",
    apps: "--apps",
  };

  if (opts.mode) {
    for (const key of incompatible[opts.mode]) {
      if (opts[key] != null) {
        throw new CliError(`${flagNames[key]} cannot be used with --mode ${opts.mode}.`);
      }
    }
  }
}

async function runInit(program: Command, opts: InitOptions) {
  const flags = program.opts();
  const outputDir = opts.outputDir ? path.resolve(opts.outputDir) : process.cwd();

  if (!fs.existsSync(outputDir)) {
    throw new CliError(`Output directory does not exist: ${outputDir}`);
  }

  validateOptions(opts);

  console.log("Welcome to Hexclave!\n");

  let mode: string;
  if (opts.mode) {
    mode = opts.mode;
  } else if (opts.selectProjectId) {
    mode = "link-cloud";
  } else if (opts.configFile) {
    mode = "link-config";
  } else {
    console.log("Creating a new Hexclave project.\n");
    const location = await select({
      message: "Where would you like to create the project?",
      choices: [
        { name: "Hexclave Cloud", value: "hosted" as const },
        { name: "Local config file", value: "local" as const },
      ],
    });
    mode = location === "local" ? "create" : "create-cloud";
  }

  let configPath: string | undefined;
  let projectId: string | undefined;

  if (mode === "link-config" || mode === "link-cloud") {
    const result = await handleLink(flags, opts, outputDir, mode);
    configPath = result.configPath;
    projectId = result.projectId;
  } else if (mode === "create") {
    const result = await handleCreate(opts, outputDir);
    configPath = result.configPath;
  } else if (mode === "create-cloud") {
    const result = await handleCreateCloud(flags, opts, outputDir);
    configPath = result.configPath;
    projectId = result.projectId;
  } else {
    throw new CliError(`Unknown mode: ${mode}`);
  }

  const initPrompt = createInitPrompt(false, configPath);
  const useAgent = opts.agent !== false && !isNonInteractiveEnv();

  if (useAgent) {
    console.log("\nRunning your coding agent to wire up Hexclave.");
    console.log("This also registers the Hexclave MCP server (https://mcp.hexclave.com)");
    console.log("so your agent can read the docs and answer Stack-specific questions going forward.\n");
    const success = await runClaudeAgent({
      prompt: `Set up Hexclave in my project now. Do not ask questions — detect the framework and package manager from existing files, apply the relevant sections of the setup guide, and skip sections for integrations this project does not use.\n\n${initPrompt}`,
      cwd: outputDir,
    });
    if (!success) {
      console.log("\nFalling back to manual instructions:\n");
      console.log(initPrompt);
    }
  } else {
    console.log("\n" + initPrompt);
  }

  const { dashboardUrl } = resolveLoginConfig();
  printNextSteps({ mode, projectId, dashboardUrl });
}

function printNextSteps(args: { mode: string, projectId?: string, dashboardUrl: string }) {
  console.log("\nYou're all set! What's next:\n");
  console.log("  • Start your dev server, then visit /handler/sign-up to create a test user");
  console.log("    (and /handler/sign-in to log in). Drop <UserButton /> into a page to see the session.");

  if (args.projectId != null) {
    console.log("  • Manage this project in the dashboard:");
    console.log(`      ${args.dashboardUrl}/projects/${encodeURIComponent(args.projectId)}`);
  }

  console.log("  • Docs: https://docs.hexclave.com");
  console.log("");
}

async function handleLink(flags: Record<string, unknown>, opts: InitOptions, outputDir: string, resolvedMode: "link-config" | "link-cloud"): Promise<{ configPath?: string, projectId?: string }> {
  if (resolvedMode === "link-config") {
    return await handleLinkFromConfigFile(opts);
  }
  return await handleLinkFromCloud(flags, opts, outputDir);
}

async function handleLinkFromConfigFile(opts: InitOptions): Promise<{ configPath: string }> {
  const filePath = opts.configFile ?? await input({
    message: "Path to your existing hexclave.config.ts (or stack.config.ts):",
    validate: (value) => {
      const resolved = path.resolve(value);
      if (!fs.existsSync(resolved)) {
        return `File not found: ${resolved}`;
      }
      if (fs.statSync(resolved).isDirectory()) {
        return `--config-file must point to a config file, but got a directory: ${resolved}`;
      }
      return true;
    },
  });

  const configPath = resolveConfigFilePathOption(filePath, { mustExist: true });

  console.log(`\nLinked to config file: ${configPath}`);
  return { configPath };
}

async function ensureLoggedInSession() {
  try {
    return resolveSessionAuth();
  } catch (e) {
    if (e instanceof AuthError) {
      if (isNonInteractiveEnv()) {
        throw new CliError("Not logged in. Run `hexclave login` first or set STACK_CLI_REFRESH_TOKEN.");
      }
      console.log("You need to log in first.\n");
      await performLogin();
      return resolveSessionAuth();
    }
    throw e;
  }
}

async function writeProjectKeysToEnv(
  project: { id: string, app: { createInternalApiKey: (opts: { description: string, expiresAt: Date, hasPublishableClientKey: boolean, hasSecretServerKey: boolean, hasSuperSecretAdminKey: boolean }) => Promise<{ publishableClientKey?: string | null, secretServerKey?: string | null }> } },
  outputDir: string,
) {
  const apiKey = await withProgress("Creating project keys", async () => {
    return await project.app.createInternalApiKey({
      description: "Created by CLI init script",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 200), // 200 years
      hasPublishableClientKey: true,
      hasSecretServerKey: true,
      hasSuperSecretAdminKey: false,
    });
  });

  const publishableClientKey = apiKey.publishableClientKey ?? throwErr("createInternalApiKey returned no publishableClientKey despite hasPublishableClientKey=true");
  const secretServerKey = apiKey.secretServerKey ?? throwErr("createInternalApiKey returned no secretServerKey despite hasSecretServerKey=true");

  const envLines = [
    "# Hexclave",
    `NEXT_PUBLIC_HEXCLAVE_PROJECT_ID=${project.id}`,
    `NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY=${publishableClientKey}`,
    `HEXCLAVE_SECRET_SERVER_KEY=${secretServerKey}`,
  ].join("\n");

  const envPath = path.resolve(outputDir, ".env");

  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, "utf-8");
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";

    if (isNonInteractiveEnv()) {
      fs.appendFileSync(envPath, separator + envLines + "\n");
      console.log("\nAppended Hexclave keys to .env");
    } else {
      const shouldAppend = await confirm({
        message: `.env file already exists. Append Hexclave keys?`,
        default: true,
      });

      if (shouldAppend) {
        fs.appendFileSync(envPath, separator + envLines + "\n");
        console.log("\nAppended Hexclave keys to .env");
      } else {
        console.log("\nHere are your environment variables:\n");
        console.log(envLines);
      }
    }
  } else {
    fs.writeFileSync(envPath, envLines + "\n");
    console.log("\nCreated .env with Hexclave keys");
  }
}

async function handleCreateCloud(_flags: Record<string, unknown>, opts: InitOptions, outputDir: string): Promise<{ configPath?: string, projectId?: string }> {
  const sessionAuth = await ensureLoggedInSession();
  const user = await withProgress("Loading account", async () => await getInternalUser(sessionAuth));

  const newProject = await createProjectInteractively(user, {
    displayName: opts.displayName,
    defaultDisplayName: path.basename(outputDir),
  });
  console.log(`\nCreated project: ${newProject.displayName} (${newProject.id})\n`);

  await writeProjectKeysToEnv(newProject, outputDir);
  return { projectId: newProject.id };
}

async function handleLinkFromCloud(_flags: Record<string, unknown>, opts: InitOptions, outputDir: string): Promise<{ configPath?: string, projectId?: string }> {
  const sessionAuth = await ensureLoggedInSession();
  const { user, ownedProjects } = await withProgress("Loading projects", async () => {
    const user = await getInternalUser(sessionAuth);
    const ownedProjects = await user.listOwnedProjects();
    return { user, ownedProjects };
  });
  let projects = ownedProjects;
  let autoCreatedProjectId: string | null = null;

  if (projects.length === 0) {
    if (opts.selectProjectId) {
      throw new CliError(`Project '${opts.selectProjectId}' not found among your owned projects. Check the ID or omit --select-project-id to create a new project interactively.`);
    }
    if (isNonInteractiveEnv()) {
      throw new CliError("No projects found. Run `hexclave project create --display-name <name>` first.");
    }

    const shouldCreate = await confirm({
      message: "You don't have any Hexclave projects yet. Would you like to create one?",
      default: true,
    });

    if (!shouldCreate) {
      const { dashboardUrl } = resolveLoginConfig();
      throw new CliError(`You don't own any projects. Create one at ${dashboardUrl} or re-run and choose to create one.`);
    }

    const newProject = await createProjectInteractively(user, {
      defaultDisplayName: path.basename(outputDir),
    });
    console.log(`\nCreated project: ${newProject.displayName} (${newProject.id})\n`);
    projects = [newProject];
    autoCreatedProjectId = newProject.id;
  }

  let projectId: string;
  if (opts.selectProjectId) {
    const found = projects.find((p) => p.id === opts.selectProjectId);
    if (!found) {
      throw new CliError(`Project '${opts.selectProjectId}' not found among your owned projects.`);
    }
    projectId = opts.selectProjectId;
  } else if (autoCreatedProjectId) {
    projectId = autoCreatedProjectId;
  } else {
    projectId = await select({
      message: "Select a project:",
      choices: projects.map((p) => ({
        name: `${p.displayName} (${p.id})`,
        value: p.id,
      })),
    });
  }

  const project = projects.find((p) => p.id === projectId)
    ?? throwErr(`Project not found: ${projectId}`);
  await writeProjectKeysToEnv(project, outputDir);
  return { projectId };
}

async function performLogin() {
  const config = resolveLoginConfig();

  const app = new StackClientApp({
    projectId: "internal",
    publishableClientKey: DEFAULT_PUBLISHABLE_CLIENT_KEY,
    baseUrl: config.apiUrl,
    tokenStore: "memory",
    noAutomaticPrefetch: true,
  });

  console.log("Waiting for browser authentication...");

  const result = await app.promptCliLogin({
    appUrl: config.dashboardUrl,
  });

  if (result.status === "error") {
    throw new CliError(`Login failed: ${result.error.message}`);
  }

  writeConfigValue("STACK_CLI_REFRESH_TOKEN", result.data);
  console.log("Login successful!\n");
}

async function handleCreate(opts: InitOptions, outputDir: string): Promise<{ configPath: string }> {
  // Hexclave rebrand: new projects get the `hexclave.config.ts` filename.
  const configPath = path.resolve(outputDir, "hexclave.config.ts");

  console.log(`\nCreating a new config file at ${configPath}!\n`);

  let selectedApps: string[];

  if (opts.apps) {
    selectedApps = opts.apps.split(",").map((s) => s.trim()).filter(Boolean);
    const validAppIds = Object.keys(ALL_APPS);
    const invalidApps = selectedApps.filter((id) => !validAppIds.includes(id));
    if (invalidApps.length > 0) {
      const availableAppIds = Object.entries(ALL_APPS)
        .filter(([, app]) => app.stage !== "alpha")
        .map(([appId]) => appId);
      throw new CliError(`Unknown app IDs: ${invalidApps.join(", ")}. Available IDs: ${availableAppIds.join(", ")}`);
    }
  } else {
    const stageOrder = { stable: 0, beta: 1 } as const;
    const appEntries = Object.entries(ALL_APPS)
      .filter(([, app]) => app.stage !== "alpha")
      .sort((a, b) => stageOrder[a[1].stage as keyof typeof stageOrder] - stageOrder[b[1].stage as keyof typeof stageOrder]);

    selectedApps = await checkbox({
      message: "Select apps to enable:",
      choices: appEntries.map(([id, app]) => ({
        name: `${app.displayName} - ${app.subtitle}${app.stage !== "stable" ? ` (${app.stage})` : ""}`,
        value: id,
        checked: id === "authentication",
      })),
    });
  }

  const validatedSelectedApps = selectedApps.filter((appId): appId is AppId => Object.prototype.hasOwnProperty.call(ALL_APPS, appId));
  if (validatedSelectedApps.length !== selectedApps.length) {
    throw new CliError("App selection contained an unknown app after validation.");
  }
  const installed = Object.fromEntries(
    [...expandAppSoftRequirements(validatedSelectedApps)].map((appId) => [appId, { enabled: true }])
  );

  const config = {
    apps: {
      installed,
    },
  };

  const importPackage = detectImportPackageFromDir(path.dirname(configPath));
  const content = renderConfigFileContent(config, importPackage);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  if (fs.existsSync(configPath)) {
    if (isNonInteractiveEnv()) {
      throw new CliError(`Config file already exists at ${configPath}. Refusing to overwrite in non-interactive mode.`);
    }
    const shouldOverwrite = await confirm({
      message: `Config file already exists at ${configPath}. Overwrite?`,
      default: false,
    });
    if (!shouldOverwrite) {
      console.log("\nLeaving existing config file unchanged.");
      return { configPath };
    }
  }

  fs.writeFileSync(configPath, content);

  console.log(`\nConfig file written to ${configPath}`);
  return { configPath };
}
