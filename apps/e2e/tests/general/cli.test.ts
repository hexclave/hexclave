import { StackAdminApp } from "@hexclave/js";
import { Result } from "@hexclave/shared/dist/utils/results";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe } from "vitest";
import { it, niceFetch, STACK_BACKEND_BASE_URL, STACK_INTERNAL_PROJECT_ADMIN_KEY, STACK_INTERNAL_PROJECT_CLIENT_KEY, STACK_INTERNAL_PROJECT_SERVER_KEY } from "../helpers";

const CLI_BIN = path.resolve("packages/cli/dist/index.js");

function extractConfigObjectString(content: string): string {
  const configMatch = content.match(/export const config:\s*HexclaveConfig\s*=\s*(.+);\s*$/s);
  if (!configMatch) {
    throw new Error(`Could not extract config object from file:\n${content}`);
  }
  return configMatch[1];
}

function runCli(
  args: string[],
  envOverrides?: Record<string, string>,
  cwd?: string,
  // `deploy` waits for remote builds (Marshal's mock builder completes on the
  // next poll at a 3s interval), so it needs more than the default.
  timeout = 30_000,
): Promise<{ stdout: string, stderr: string, exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile("node", [CLI_BIN, ...args], {
      env: { ...baseEnv, ...envOverrides },
      cwd,
      timeout,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

let baseEnv: Record<string, string>;
let tmpDir: string;
let configFilePath: string;
let refreshToken: string;

describe("Stack CLI", () => {
  beforeAll(async () => {
    // Check CLI is built
    if (!fs.existsSync(CLI_BIN)) {
      throw new Error("CLI not built. Run `pnpm --filter @hexclave/cli run build` first.");
    }

    // Create temp dir for config file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-test-"));
    configFilePath = path.join(tmpDir, "credentials.json");

    // Create test user on internal project (auto-creates team)
    const internalApp = new StackAdminApp({
      projectId: "internal",
      baseUrl: STACK_BACKEND_BASE_URL,
      publishableClientKey: STACK_INTERNAL_PROJECT_CLIENT_KEY,
      secretServerKey: STACK_INTERNAL_PROJECT_SERVER_KEY,
      superSecretAdminKey: STACK_INTERNAL_PROJECT_ADMIN_KEY,
      tokenStore: "memory",
      redirectMethod: "none",
    });

    const fakeEmail = `cli-test-${crypto.randomUUID()}@stack-generated.example.com`;
    Result.orThrow(await internalApp.signUpWithCredential({
      email: fakeEmail,
      password: "test-password-123",
      noVerificationCallback: true,
    }));

    const user = await internalApp.getUser({ or: "throw" });

    // Create a session to get a refresh token
    const sessionRes = await niceFetch(`${STACK_BACKEND_BASE_URL}/api/v1/auth/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stack-access-type": "server",
        "x-stack-project-id": "internal",
        "x-stack-publishable-client-key": STACK_INTERNAL_PROJECT_CLIENT_KEY,
        "x-stack-secret-server-key": STACK_INTERNAL_PROJECT_SERVER_KEY,
      },
      body: JSON.stringify({
        user_id: user.id,
        expires_in_millis: 1000 * 60 * 60 * 24,
        is_impersonation: false,
      }),
    });

    if (sessionRes.status !== 200) {
      throw new Error(`Failed to create session: ${sessionRes.status} ${JSON.stringify(sessionRes.body)}`);
    }
    refreshToken = sessionRes.body.refresh_token;

    // Set base env for CLI
    baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      STACK_API_URL: STACK_BACKEND_BASE_URL,
      STACK_CLI_REFRESH_TOKEN: refreshToken,
      STACK_CLI_PUBLISHABLE_CLIENT_KEY: STACK_INTERNAL_PROJECT_CLIENT_KEY,
      STACK_CLI_CONFIG_PATH: configFilePath,
      CI: "1",
    };
  }, 120_000);

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("shows help output", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hexclave CLI");
  });

  it("shows version output", async ({ expect }) => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("packages/cli/package.json"), "utf-8"));
    const { stdout, exitCode } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("errors when not logged in", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["project", "list"], {
      STACK_CLI_REFRESH_TOKEN: "",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Not logged in");
  });

  it("exec errors when neither --cloud-project-id nor --config-file is given", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["exec", "return 1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Specify a target");
  });

  it("exec errors when both --cloud-project-id and --config-file are given", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["exec", "--cloud-project-id", "proj_x", "--config-file", "./stack.config.ts", "return 1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not both");
  });

  it("logout clears config", async ({ expect }) => {
    // Write a fake token to the config file
    fs.writeFileSync(configFilePath, JSON.stringify({ STACK_CLI_REFRESH_TOKEN: "fake-token" }), { mode: 0o600 });

    const { stdout, exitCode } = await runCli(["logout"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged out");

    const content = fs.readFileSync(configFilePath, "utf-8");
    expect(content).not.toContain("fake-token");
  });

  let createdProjectId: string;

  it("lists cloud projects as empty JSON array", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(["--json", "project", "list", "--cloud"]);
    expect(exitCode).toBe(0);
    const projects = JSON.parse(stdout);
    expect(Array.isArray(projects)).toBe(true);
  });

  it("project create requires --cloud", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["project", "create", "--display-name", "Should Fail"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--cloud to confirm");
  });

  it("project list rejects --cloud and --local together", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["project", "list", "--cloud", "--local"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not both");
  });

  it("creates a project", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(["--json", "project", "create", "--cloud", "--display-name", "CLI Test"]);
    expect(exitCode).toBe(0);
    const project = JSON.parse(stdout);
    expect(project).toHaveProperty("id");
    expect(project).toHaveProperty("displayName");
    expect(project.target).toBe("cloud");
    expect(project.displayName).toBe("CLI Test");
    createdProjectId = project.id;
  });

  it("lists cloud projects including created one with target=cloud", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();
    const { stdout, exitCode } = await runCli(["--json", "project", "list", "--cloud"]);
    expect(exitCode).toBe(0);
    const projects = JSON.parse(stdout);
    const found = projects.find((p: any) => p.id === createdProjectId);
    expect(found).toBeDefined();
    expect(found.displayName).toBe("CLI Test");
    expect(found.target).toBe("cloud");
  });

  it("returns basic expression", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return 1+1"],
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("2");
  });

  it("has hexclaveServerApp object available", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return typeof hexclaveServerApp"],
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('"object"');
  });

  it("exec help mentions docs URL", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(["exec", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("https://docs.hexclave.com/sdk/overview");
  });

  it("exec help mentions --cloud-project-id and --config-file", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(["exec", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--cloud-project-id");
    expect(stdout).toContain("--config-file");
  });

  it("errors when no javascript is provided", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(["exec", "--cloud-project-id", createdProjectId]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Missing JavaScript argument");
  });

  it("reports syntax error", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return @@invalid"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Syntax error");
  });

  it("reports runtime error", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "throw new Error('boom')"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("boom");
  });

  it("reports string runtime error", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "throw 'boom-string'"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("boom-string");
  });

  it("reports object runtime error", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "throw { code: 123 }"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('{"code":123}');
  });

  it("reports undefined variable", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return nonExistentVar"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nonExistentVar");
  });

  it("returns undefined for no return value", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "const x = 1"],
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("returns complex object as JSON", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return {a: 1, b: [2, 3]}"],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ a: 1, b: [2, 3] });
  });

  it("supports async code", async ({ expect }) => {
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "return await Promise.resolve(42)"],
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("42");
  });

  let createdUserEmail: string;

  it("can create user with hexclaveServerApp", async ({ expect }) => {
    createdUserEmail = `exec-test-${crypto.randomUUID()}@stack-generated.example.com`;
    const code = `const u = await hexclaveServerApp.createUser({ primaryEmail: "${createdUserEmail}", password: "test123456" }); return { id: u.id, email: u.primaryEmail }`;
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, code],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("id");
    expect(parsed.email).toBe(createdUserEmail);
  });

  it("can list users with hexclaveServerApp", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();
    expect(createdUserEmail).toBeDefined();
    const { stdout, exitCode } = await runCli(
      ["exec", "--cloud-project-id", createdProjectId, "const users = await hexclaveServerApp.listUsers(); return users.length"],
    );
    expect(exitCode).toBe(0);
    const count = JSON.parse(stdout);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("exec --config-file errors when the config file does not exist", async ({ expect }) => {
    const { stderr, exitCode } = await runCli(
      ["exec", "--config-file", path.join(tmpDir, "missing-stack.config.ts"), "return 1"],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Config file not found");
  });

  it("exec --config-file errors when no local dashboard session exists", async ({ expect }) => {
    const devEnvStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-no-dashboard-"));
    const configFile = path.join(tmpDir, `cfg-no-dashboard-${crypto.randomUUID()}.config.ts`);
    fs.writeFileSync(configFile, "");
    try {
      const { stderr, exitCode } = await runCli(
        ["exec", "--config-file", configFile, "return 1"],
        {
          STACK_DEV_ENVS_PATH: path.join(devEnvStateDir, "dev-envs.json"),
        },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("No local dashboard session found");
    } finally {
      fs.rmSync(devEnvStateDir, { recursive: true });
    }
  });

  it("exec --config-file runs against the local dashboard project from dev-env state", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();
    const devEnvStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-dashboard-state-"));
    const configFile = path.join(tmpDir, `cfg-dashboard-state-${crypto.randomUUID()}.config.ts`);
    fs.writeFileSync(configFile, "");
    const statePath = path.join(devEnvStateDir, "dev-envs.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      anonymousRefreshToken: refreshToken,
      projectsByConfigPath: {
        [configFile]: {
          projectId: createdProjectId,
          teamId: "team_e2e_placeholder",
          publishableClientKey: "pck_e2e_placeholder",
          secretServerKey: "ssk_e2e_placeholder",
          apiBaseUrl: STACK_BACKEND_BASE_URL,
          updatedAtMillis: Date.now(),
        },
      },
    }), { mode: 0o600 });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["exec", "--config-file", configFile, "return 1+1"],
        {
          STACK_DEV_ENVS_PATH: statePath,
        },
      );
      if (exitCode !== 0) {
        throw new Error(`CLI exited ${exitCode}. stderr: ${stderr}`);
      }
      expect(stdout.trim()).toBe("2");
    } finally {
      fs.rmSync(devEnvStateDir, { recursive: true });
    }
  });

  let configTsPath: string;

  it("config pull writes a .ts file", async ({ expect }) => {
    configTsPath = path.join(tmpDir, "config.ts");
    const { stdout, exitCode } = await runCli(
      ["config", "pull", "--cloud-project-id", createdProjectId, "--config-file", configTsPath],
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Config written to");
    const content = fs.readFileSync(configTsPath, "utf-8");
    expect(content).toContain('import type { HexclaveConfig } from "@hexclave/js";');
    expect(content).toContain("export const config: HexclaveConfig");
  });

  it("config push succeeds", async ({ expect }) => {
    expect(configTsPath).toBeDefined();
    const { stdout, exitCode } = await runCli(
      ["config", "push", "--cloud-project-id", createdProjectId, "--config-file", configTsPath],
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Config pushed successfully");
  });

  it("config pull rejects bad extension", async ({ expect }) => {
    const badPath = path.join(tmpDir, "config.json");
    const { stderr, exitCode } = await runCli(
      ["config", "pull", "--cloud-project-id", createdProjectId, "--config-file", badPath],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".ts extension");
  });

  it("deploy deploys the services export in dependency order and waits for the builds", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();
    const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-deploy-"));
    try {
      // web builds from an explicit Dockerfile (dockerfilePath + pre-flight);
      // db has none, covering the Railpack auto-detection default. web's
      // dockerfilePath is written relative to its rootDirectory ("./web"), so
      // the bare "Dockerfile" below must reach the server as "web/Dockerfile"
      // — this is the end-to-end proof that the CLI joins the two.
      fs.mkdirSync(path.join(deployDir, "web"));
      fs.writeFileSync(path.join(deployDir, "web", "index.html"), "<h1>web</h1>");
      fs.writeFileSync(path.join(deployDir, "web", "Dockerfile"), "FROM nginx:alpine\n");
      fs.mkdirSync(path.join(deployDir, "db"));
      fs.writeFileSync(path.join(deployDir, "db", "index.html"), "<h1>db</h1>");
      // api has neither a Dockerfile nor an image, but declares commands — so it
      // is built on the Hexclave base image instead of being auto-detected.
      fs.mkdirSync(path.join(deployDir, "api"));
      fs.writeFileSync(path.join(deployDir, "api", "server.js"), "console.log('api');\n");
      // Two files: the project config, and the deploy file holding the services.
      // They are pushed by two DIFFERENT commands — `hexclave deploy` ships the
      // services and never touches the configuration.
      const configFilePath = path.join(deployDir, "hexclave.config.ts");
      const writeConfigFile = (allowClientTeamCreation: boolean) => fs.writeFileSync(configFilePath,
        `export const config = { teams: { allowClientTeamCreation: ${allowClientTeamCreation} } };\n`);
      fs.writeFileSync(path.join(deployDir, "hexclave.deploy.ts"), [
        // The `deploymentGroupId` export names this deployment group — which
        // deploy file (and so which repository) these services belong to.
        'export const deploymentGroupId = "cli-e2e";',
        "export const deploy = ({ isDev, secret, service, hexclave }: any) => ({",
        "  services: {",
        "    web: {",
        '      type: "serverless",',
        '      ports: { 3000: { protocol: "http" } },',
        '      rootDirectory: "./web",',
        '      dockerfilePath: "Dockerfile",',
        '      devCommand: "npm run dev",',
        "      env: {",
        '        DB_URL: service("db").url(5432),',
        "        PROJECT_ID: hexclave.projectId,",
        '        OPENAI: isDev ? null : secret("OPENAI_KEY", "sk-default"),',
        "      },",
        "    },",
        '    db: { type: "serverless", ports: { 5432: { protocol: "http" } }, rootDirectory: "./db" },',
        "    api: {",
        '      type: "serverless",',
        '      ports: { 8080: { protocol: "http" } },',
        '      rootDirectory: "./api",',
        // No image and no dockerfilePath: the base-image build, where the start
        // command is what makes the result runnable at all.
        '      buildCommand: "node -e \\"process.exit(0)\\"",',
        '      startCommand: "node server.js",',
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"));
      // Pushed with `config push`, so the deploy below has a known config to
      // leave alone. Then changed on disk WITHOUT being pushed: the assertion
      // after the deploy is that the deploy did not publish this edit.
      writeConfigFile(true);
      const configPushRes = await runCli(
        ["config", "push", "--cloud-project-id", createdProjectId, "--config-file", configFilePath],
      );
      if (configPushRes.exitCode !== 0) {
        throw new Error(`config push exited ${configPushRes.exitCode}. stderr: ${configPushRes.stderr}`);
      }
      writeConfigFile(false);
      const { stdout, stderr, exitCode } = await runCli(
        ["deploy", "--cloud-project-id", createdProjectId, "--deploy-file", path.join(deployDir, "hexclave.deploy.ts")],
        {},
        deployDir,
        90_000,
      );
      if (exitCode !== 0) {
        throw new Error(`deploy exited ${exitCode}. stderr: ${stderr}\nstdout: ${stdout}`);
      }
      // stdout is the machine-readable summary; both services must have built
      // to ready. Container services are private by default, so neither has a
      // public URL until a custom domain is attached.
      const summary = JSON.parse(stdout);
      expect(summary.deploymentSourceId).toBe("cli-e2e");
      expect(summary.status).toBe("deployed");
      expect(summary.services.db.status).toBe("deployed");
      expect(summary.services.web.status).toBe("deployed");
      expect(summary.services.api.status).toBe("deployed");
      expect(summary.services.db.url).toBeNull();
      expect(summary.services.web.url).toBeNull();
      // Both services shipped from ONE deploy — one upload, one build. Assert
      // this on the terminal output, which is always emitted; the in-progress
      // "Building every service in one builder" line is not, because a fast
      // build can go from queued to deploying between two 3s polls.
      const occurrencesOf = (needle: string) => stderr.split(needle).length - 1;
      expect(occurrencesOf("Uploading source...")).toBe(1);
      expect(occurrencesOf("Waiting for the remote build...")).toBe(1);
      expect(stderr).toContain("[web] deployed");
      expect(stderr).toContain("[db] deployed");
      // The definitions were synced server-side — but NOT the deploy file's
      // `devCommand`, which `hexclave dev` runs locally and the CLI therefore
      // never sends (web declares one above, so this also covers that a
      // devCommand doesn't trip the sync route).
      // OPENAI also proves the secret-default path end to end: nothing set a
      // value for OPENAI_KEY, so this deploy only succeeded because the CLI
      // sent `secret("OPENAI_KEY", "sk-default")`'s default with the deploy
      // request — while the SYNCED definition names the secret and nothing
      // else, so the default was never persisted.
      const execRes = await runCli([
        "exec", "--cloud-project-id", createdProjectId,
        "const p = await hexclaveServerApp.getProject(); const services = await p.listDeploymentServices(); const svc = services.find(s => s.id === 'web'); const api = services.find(s => s.id === 'api'); return JSON.stringify({ hasDevCommand: 'dev_command' in svc, keys: svc.env.map(e => e.key).sort(), openai: svc.env.find(e => e.key === 'OPENAI'), webDockerfile: svc.dockerfile_path, dbDockerfile: services.find(s => s.id === 'db').dockerfile_path, apiBuild: api.build_command, apiStart: api.start_command, apiRoot: api.root_directory, webStart: svc.start_command });",
      ]);
      if (execRes.exitCode !== 0) {
        throw new Error(`exec exited ${execRes.exitCode}. stderr: ${execRes.stderr}`);
      }
      expect(JSON.parse(JSON.parse(execRes.stdout.trim()))).toEqual({
        hasDevCommand: false,
        keys: ["DB_URL", "OPENAI", "PROJECT_ID"],
        openai: { key: "OPENAI", type: "secret", value: null, secret_key: "OPENAI_KEY" },
        // Authored as a bare "Dockerfile" under rootDirectory "./web" and stored with the
        // root directory joined on — relative to the UPLOAD ROOT, because the build context
        // is the whole upload (that is what lets a monorepo service COPY shared code from
        // above its own directory), so this is the path the builder opens.
        webDockerfile: "web/Dockerfile",
        // No dockerfilePath at all: db is built by Railpack auto-detection.
        dbDockerfile: null,
        // The commands reach the server; a service that declares none has null,
        // which is what keeps "auto-detected" distinguishable from "told what to
        // do" all the way through.
        apiBuild: 'node -e "process.exit(0)"',
        apiStart: "node server.js",
        apiRoot: "api",
        webStart: null,
      });

      // A secret with NO default and no stored value fails before anything is
      // packaged, naming every key that needs a dashboard value.
      fs.writeFileSync(path.join(deployDir, "missing-secret.deploy.ts"), [
        'export const deploymentGroupId = "cli-e2e-missing-secret";',
        "export const deploy = ({ secret }: any) => ({",
        "  services: {",
        '    web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory: "./web", env: { A: secret("NEEDS_A_VALUE"), B: secret("ALSO_NEEDED") } },',
        "  },",
        "});",
        "",
      ].join("\n"));
      const missingSecretRes = await runCli(
        ["deploy", "--cloud-project-id", createdProjectId, "--deploy-file", path.join(deployDir, "missing-secret.deploy.ts")],
        {},
        deployDir,
      );
      expect(missingSecretRes.exitCode).not.toBe(0);
      expect(missingSecretRes.stderr).toContain("ALSO_NEEDED");
      expect(missingSecretRes.stderr).toContain("NEEDS_A_VALUE");
      expect(missingSecretRes.stderr).toContain("Project Settings > Secrets");

      // Deploying is not publishing: the config file next to the deploy file was
      // changed to `false` before the deploy and never pushed, so the project
      // must still hold what `config push` put there.
      const readBranchConfig = async () => {
        const configRes = await runCli([
          "exec", "--cloud-project-id", createdProjectId,
          "const p = await hexclaveServerApp.getProject(); return JSON.stringify(await p.getConfigOverride('branch'));",
        ]);
        if (configRes.exitCode !== 0) {
          throw new Error(`exec exited ${configRes.exitCode}. stderr: ${configRes.stderr}`);
        }
        return JSON.parse(JSON.parse(configRes.stdout.trim()));
      };
      expect(await readBranchConfig()).toMatchObject({ teams: { allowClientTeamCreation: true } });

      // Services can no longer live in the config file, and a `deploy` export
      // there is refused rather than ignored: pushing it silently would leave
      // the author believing their services had been published.
      fs.writeFileSync(configFilePath, [
        "export const config = { teams: { allowClientTeamCreation: false } };",
        "export const deploy = () => ({ services: {} });",
        "",
      ].join("\n"));
      const configWithDeployRes = await runCli(
        ["config", "push", "--cloud-project-id", createdProjectId, "--config-file", configFilePath],
      );
      expect(configWithDeployRes.exitCode).not.toBe(0);
      expect(configWithDeployRes.stderr).toContain("hexclave.deploy.ts");
      writeConfigFile(false);

      // --service-id deploys just that service.
      const singleRun = await runCli(
        ["deploy", "--cloud-project-id", createdProjectId, "--deploy-file", path.join(deployDir, "hexclave.deploy.ts"), "--service-id", "db"],
        {},
        deployDir,
        90_000,
      );
      if (singleRun.exitCode !== 0) {
        throw new Error(`deploy --service-id exited ${singleRun.exitCode}. stderr: ${singleRun.stderr}\nstdout: ${singleRun.stdout}`);
      }
      const singleSummary = JSON.parse(singleRun.stdout);
      expect(Object.keys(singleSummary.services)).toEqual(["db"]);
      expect(singleSummary.services.db.status).toBe("deployed");
      expect(await readBranchConfig()).toMatchObject({ teams: { allowClientTeamCreation: true } });
    } finally {
      fs.rmSync(deployDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("config push rejects array config export", async ({ expect }) => {
    const badConfigPath = path.join(tmpDir, "config-array.ts");
    fs.writeFileSync(badConfigPath, "export const config = [];\n");
    const { stderr, exitCode } = await runCli(
      ["config", "push", "--cloud-project-id", createdProjectId, "--config-file", badConfigPath],
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("plain `config` object");
  });

  it("config pull refuses to clobber an existing file without --overwrite", async ({ expect }) => {
    const existingConfigPath = path.join(tmpDir, "existing-config.ts");
    fs.writeFileSync(existingConfigPath, "existing\n");

    const { stderr, exitCode } = await runCli(
      ["config", "pull", "--cloud-project-id", createdProjectId, "--config-file", existingConfigPath],
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
    expect(stderr).toContain("--overwrite");
    // The existing file must be left untouched.
    expect(fs.readFileSync(existingConfigPath, "utf-8")).toBe("existing\n");
  });

  it("config pull replaces an existing file with --overwrite", async ({ expect }) => {
    const existingConfigPath = path.join(tmpDir, "existing-config-overwrite.ts");
    fs.writeFileSync(existingConfigPath, "existing\n");

    const { stdout, exitCode } = await runCli(
      ["config", "pull", "--cloud-project-id", createdProjectId, "--config-file", existingConfigPath, "--overwrite"],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Config written to");
    const content = fs.readFileSync(existingConfigPath, "utf-8");
    expect(content).toContain("export const config: HexclaveConfig");
  });

  it("config pull falls back to ./hexclave.config.ts in cwd when --config-file is omitted", async ({ expect }) => {
    // realpathSync normalizes macOS's /var/folders/... → /private/var/folders/...
    // (Node resolves the symlink when reporting the written path).
    const cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-config-pull-cwd-")));
    const expected = path.join(cwdDir, "hexclave.config.ts");
    try {
      const { stdout, exitCode } = await runCli(
        ["config", "pull", "--cloud-project-id", createdProjectId],
        undefined,
        cwdDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`Config written to ${expected}`);
      const content = fs.readFileSync(expected, "utf-8");
      expect(content).toContain("export const config: HexclaveConfig");
    } finally {
      fs.rmSync(cwdDir, { recursive: true });
    }
  });

  it("config pull still prefers an existing ./stack.config.ts when --config-file is omitted (with --overwrite)", async ({ expect }) => {
    const cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-config-pull-empty-")));
    const expected = path.join(cwdDir, "stack.config.ts");
    fs.writeFileSync(expected, "// placeholder so the file exists\n");
    try {
      const { stdout, exitCode } = await runCli(
        ["config", "pull", "--cloud-project-id", createdProjectId, "--overwrite"],
        undefined,
        cwdDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`Config written to ${expected}`);
      const content = fs.readFileSync(expected, "utf-8");
      expect(content).toContain("export const config: HexclaveConfig");
    } finally {
      fs.rmSync(cwdDir, { recursive: true });
    }
  });

  // --- init command tests ---

  // TODO: Re-enable these create-mode tests once init mode handling is finalized.
  // We keep these skipped (instead of todo) so the test logic remains visible and easy to re-enable.
  it.skip("init create writes stack.config.ts with selected apps", async ({ expect }) => {
    const initDir = path.join(tmpDir, "init-create");
    fs.mkdirSync(initDir, { recursive: true });

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "create", "--apps", "authentication,teams", "--output-dir", initDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Config file written to");

    const content = fs.readFileSync(path.join(initDir, "stack.config.ts"), "utf-8");
    expect(content).toContain('import type { HexclaveConfig } from "@hexclave/js";');
    expect(content).toContain("export const config: HexclaveConfig");
    expect(JSON.parse(extractConfigObjectString(content))).toMatchObject({
      apps: {
        installed: {
          authentication: { enabled: true },
          emails: { enabled: true },
          teams: { enabled: true },
        },
      },
    });
  });

  it.skip("init create with single app", async ({ expect }) => {
    const initDir = path.join(tmpDir, "init-create-single");
    fs.mkdirSync(initDir, { recursive: true });

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "create", "--apps", "authentication", "--output-dir", initDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Config file written to");

    const content = fs.readFileSync(path.join(initDir, "stack.config.ts"), "utf-8");
    expect(JSON.parse(extractConfigObjectString(content))).toMatchObject({
      apps: {
        installed: {
          authentication: { enabled: true },
          emails: { enabled: true },
        },
      },
    });
    expect(content).not.toContain('"teams"');
  });

  it("init link-config with valid path", async ({ expect }) => {
    // Create a dummy config file to link to
    const dummyConfig = path.join(tmpDir, "dummy-stack.config.ts");
    fs.writeFileSync(dummyConfig, "export const config = {};\n");

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "link-config", "--config-file", dummyConfig,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Linked to config file");
    expect(stdout).toContain(dummyConfig);
  });

  it("init link-config with invalid path fails", async ({ expect }) => {
    const { stderr, exitCode } = await runCli([
      "init", "--mode", "link-config", "--config-file", "/nonexistent/stack.config.ts",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Config file not found");
  });

  it("init link-cloud creates .env with API keys", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();

    const initDir = path.join(tmpDir, "init-cloud");
    fs.mkdirSync(initDir, { recursive: true });

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "link-cloud", "--select-project-id", createdProjectId, "--output-dir", initDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .env with Hexclave keys");

    const envContent = fs.readFileSync(path.join(initDir, ".env"), "utf-8");
    expect(envContent).toContain("# Hexclave");
    expect(envContent).toContain(`NEXT_PUBLIC_HEXCLAVE_PROJECT_ID=${createdProjectId}`);
    expect(envContent).toContain("NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY=");
    expect(envContent).toContain("HEXCLAVE_SECRET_SERVER_KEY=");
  });

  it("init link-cloud appends to existing .env", async ({ expect }) => {
    expect(createdProjectId).toBeDefined();

    const initDir = path.join(tmpDir, "init-cloud-append");
    fs.mkdirSync(initDir, { recursive: true });
    fs.writeFileSync(path.join(initDir, ".env"), "EXISTING_VAR=hello\n");

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "link-cloud", "--select-project-id", createdProjectId, "--output-dir", initDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Appended Hexclave keys to .env");

    const envContent = fs.readFileSync(path.join(initDir, ".env"), "utf-8");
    expect(envContent).toContain("EXISTING_VAR=hello");
    expect(envContent).toContain("# Hexclave");
    expect(envContent).toContain(`NEXT_PUBLIC_HEXCLAVE_PROJECT_ID=${createdProjectId}`);
  });

  it("init link-cloud fails with invalid project ID", async ({ expect }) => {
    const { stderr, exitCode } = await runCli([
      "init", "--mode", "link-cloud", "--select-project-id", "nonexistent-project-id",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  it.skip("init outputs setup instructions", async ({ expect }) => {
    const initDir = path.join(tmpDir, "init-instructions");
    fs.mkdirSync(initDir, { recursive: true });

    const { stdout, exitCode } = await runCli([
      "init", "--mode", "create", "--apps", "authentication", "--output-dir", initDir,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("HEXCLAVE SETUP INSTRUCTIONS");
  });
});

// Doctor CLI tests — no backend required. Each test builds a fixture project
// in a temp dir and runs `stack doctor --output-dir <dir> --json`.
describe("Stack CLI — Doctor", () => {
  let doctorTmpRoot: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI_BIN)) {
      throw new Error("CLI not built. Run `pnpm --filter @hexclave/cli run build` first.");
    }
    doctorTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-doctor-test-"));
  });

  afterAll(() => {
    if (doctorTmpRoot && fs.existsSync(doctorTmpRoot)) {
      fs.rmSync(doctorTmpRoot, { recursive: true });
    }
  });

  function runDoctor(
    args: string[],
    envOverrides?: Record<string, string>,
  ): Promise<{ stdout: string, stderr: string, exitCode: number | null }> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CI: "1",
      ...envOverrides,
    };
    return new Promise((resolve) => {
      execFile("node", [CLI_BIN, ...args], {
        env,
        timeout: 30_000,
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      });
    });
  }

  function makeProject(subdir: string, files: Record<string, string>): string {
    const dir = path.join(doctorTmpRoot, `${subdir}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  function pkg(extra: Record<string, unknown>): string {
    return JSON.stringify({ name: "fixture", version: "0.0.0", ...extra }, null, 2);
  }

  // Reusable Next.js all-green fixture
  function nextHappyFiles(): Record<string, string> {
    return {
      "package.json": pkg({
        dependencies: { next: "14.0.0", "@hexclave/next": "1.0.0" },
      }),
      "hexclave/client.ts": "export const hexclaveClientApp = {};\n",
      "hexclave/server.ts": "export const hexclaveServerApp = {};\n",
      "app/handler/[...hexclave]/page.tsx": "export default function Page() { return null; }\n",
      "app/layout.tsx":
        `import { HexclaveProvider } from "@hexclave/next";\n` +
        `export default function RootLayout({ children }) {\n` +
        `  return <HexclaveProvider>{children}</HexclaveProvider>;\n` +
        `}\n`,
      ".env.local":
        `NEXT_PUBLIC_STACK_PROJECT_ID=proj_test\n` +
        `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=pck_test\n` +
        `STACK_SECRET_SERVER_KEY="ssk_test"\n`,
    };
  }

  it("doctor --help shows options", async ({ expect }) => {
    const { stdout, exitCode } = await runDoctor(["doctor", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--output-dir");
    expect(stdout).toContain("--framework");
    expect(stdout).toContain("--json");
  });

  it("fails when package.json is missing", async ({ expect }) => {
    const dir = makeProject("no-pkg", {});
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("no package.json");
    expect(parsed.projectDir).toBe(dir);
  });

  it("fails when package.json is invalid JSON", async ({ expect }) => {
    const dir = makeProject("bad-pkg", { "package.json": "not json" });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBe("invalid package.json");
    expect(typeof parsed.detail).toBe("string");
    expect(parsed.detail.length).toBeGreaterThan(0);
  });

  it("fails when no dependencies declared", async ({ expect }) => {
    const dir = makeProject("empty-deps", { "package.json": pkg({}) });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("no dependencies");
  });

  it("rejects Next.js project without app router", async ({ expect }) => {
    const dir = makeProject("next-pages", {
      "package.json": pkg({ dependencies: { next: "14.0.0" } }),
      "pages/index.tsx": "export default function Home() { return null; }\n",
    });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("pages router");
  });

  it("rejects unknown --framework value", async ({ expect }) => {
    const dir = makeProject("bad-fw", { "package.json": pkg({ dependencies: { next: "14.0.0" } }) });
    const { stdout, exitCode } = await runDoctor([
      "doctor", "--output-dir", dir, "--framework", "bogus", "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Unknown framework");
  });

  it("--framework override applies even when deps don't list it", async ({ expect }) => {
    const dir = makeProject("fw-override", {
      "package.json": pkg({ dependencies: { something: "1.0.0" } }),
      "app/marker.txt": "ensures app router exists\n",
    });
    const { stdout, exitCode } = await runDoctor([
      "doctor", "--output-dir", dir, "--framework", "next", "--json",
    ]);
    // Will fail many checks (no Stack package, no files), but framework should be next.
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("next");
  });

  it("Next.js happy path passes all checks", async ({ expect }) => {
    const dir = makeProject("next-happy", nextHappyFiles());
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("next");
    expect(parsed.failed).toBe(0);
    expect(parsed.warned).toBe(0);
    expect(parsed.checks.every((c: any) => c.status === "pass")).toBe(true);
  });

  it("Next.js legacy stack paths are still accepted", async ({ expect }) => {
    const files = nextHappyFiles();
    files["stack/client.ts"] = files["hexclave/client.ts"];
    files["stack/server.ts"] = files["hexclave/server.ts"];
    files["app/handler/[...stack]/page.tsx"] = files["app/handler/[...hexclave]/page.tsx"];
    delete files["hexclave/client.ts"];
    delete files["hexclave/server.ts"];
    delete files["app/handler/[...hexclave]/page.tsx"];
    const dir = makeProject("next-legacy-stack-paths", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.failed).toBe(0);
  });

  it("Next.js applies src/ prefix when src/app exists", async ({ expect }) => {
    const dir = makeProject("next-src", {
      "package.json": pkg({
        dependencies: { next: "14.0.0", "@hexclave/next": "1.0.0" },
      }),
      "src/hexclave/client.ts": "export const hexclaveClientApp = {};\n",
      "src/hexclave/server.ts": "export const hexclaveServerApp = {};\n",
      "src/app/handler/[...hexclave]/page.tsx": "export default function P() { return null; }\n",
      "src/app/layout.tsx":
        `import { HexclaveProvider } from "@hexclave/next";\n` +
        `export default function L({ children }) { return <HexclaveProvider>{children}</HexclaveProvider>; }\n`,
      ".env.local":
        `NEXT_PUBLIC_STACK_PROJECT_ID=p\n` +
        `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=k\n` +
        `STACK_SECRET_SERVER_KEY=s\n`,
    });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const clientCheck = parsed.checks.find((c: any) => c.id === "next.client-app");
    expect(clientCheck.status).toBe("pass");
    expect(clientCheck.label).toContain("src/hexclave/client.ts");
  });

  it("React happy path passes all checks", async ({ expect }) => {
    const dir = makeProject("react-happy", {
      "package.json": pkg({
        dependencies: { react: "18.0.0", "@hexclave/react": "1.0.0" },
      }),
      "hexclave/client.ts": "export const hexclaveClientApp = {};\n",
      ".env.local":
        `VITE_STACK_PROJECT_ID=p\n` +
        `VITE_STACK_PUBLISHABLE_CLIENT_KEY=k\n`,
    });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("react");
    expect(parsed.failed).toBe(0);
  });

  it("JS catch-all happy path passes all checks", async ({ expect }) => {
    const dir = makeProject("js-happy", {
      "package.json": pkg({
        dependencies: { svelte: "4.0.0", "@hexclave/js": "1.0.0" },
      }),
      "hexclave/server.ts": "export const hexclaveServerApp = {};\n",
      ".env":
        `STACK_PROJECT_ID=p\n` +
        `STACK_PUBLISHABLE_CLIENT_KEY=k\n` +
        `STACK_SECRET_SERVER_KEY=s\n`,
    });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("js");
    expect(parsed.failed).toBe(0);
  });

  it("JS catch-all accepts PUBLIC_* env aliases", async ({ expect }) => {
    const dir = makeProject("js-public", {
      "package.json": pkg({
        dependencies: { svelte: "4.0.0", "@hexclave/js": "1.0.0" },
      }),
      "hexclave/client.ts": "export const hexclaveClientApp = {};\n",
      ".env":
        `PUBLIC_STACK_PROJECT_ID=p\n` +
        `PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=k\n` +
        `STACK_SECRET_SERVER_KEY=s\n`,
    });
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("js");
    expect(parsed.failed).toBe(0);
  });

  it("fails when @hexclave/next is not installed", async ({ expect }) => {
    const files = nextHappyFiles();
    files["package.json"] = pkg({ dependencies: { next: "14.0.0" } });
    const dir = makeProject("no-stack-pkg", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.package");
    expect(check.status).toBe("fail");
  });

  it("fails when client app file is missing", async ({ expect }) => {
    const files = nextHappyFiles();
    delete files["hexclave/client.ts"];
    const dir = makeProject("no-client", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.client-app");
    expect(check.status).toBe("fail");
  });

  it("fails when handler route is missing", async ({ expect }) => {
    const files = nextHappyFiles();
    delete files["app/handler/[...hexclave]/page.tsx"];
    const dir = makeProject("no-handler", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.handler-route");
    expect(check.status).toBe("fail");
    expect(check.hint).toContain("app/handler/[...hexclave]/page.tsx");
  });

  it("warns when layout imports StackProvider but does not render it", async ({ expect }) => {
    const files = nextHappyFiles();
    files["app/layout.tsx"] =
      `import { StackProvider } from "@hexclave/next";\n` +
      `export default function L({ children }) { return <html><body>{children}</body></html>; }\n`;
    const dir = makeProject("layout-no-jsx", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    // Warn does not flip exit code.
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.layout-provider");
    expect(check.status).toBe("warn");
  });

  it("fails when layout renders <StackProvider> without importing it", async ({ expect }) => {
    const files = nextHappyFiles();
    files["app/layout.tsx"] =
      `export default function L({ children }) { return <StackProvider>{children}</StackProvider>; }\n`;
    const dir = makeProject("layout-no-import", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.layout-provider");
    expect(check.status).toBe("fail");
  });

  it("fails when layout file is missing entirely", async ({ expect }) => {
    const files = nextHappyFiles();
    delete files["app/layout.tsx"];
    const dir = makeProject("layout-missing", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "next.layout-provider");
    expect(check.status).toBe("fail");
  });

  it("fails when a required env var is missing", async ({ expect }) => {
    const files = nextHappyFiles();
    files[".env.local"] =
      `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=k\n` +
      `STACK_SECRET_SERVER_KEY=s\n`;
    const dir = makeProject("env-fail", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "env-vars");
    expect(check.status).toBe("fail");
    expect(check.label).toContain("NEXT_PUBLIC_STACK_PROJECT_ID");
  });

  it("warns (without failing) when only the recommended env var is missing", async ({ expect }) => {
    const files = nextHappyFiles();
    files[".env.local"] =
      `NEXT_PUBLIC_STACK_PROJECT_ID=p\n` +
      `STACK_SECRET_SERVER_KEY=s\n`;
    const dir = makeProject("env-warn", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "env-vars");
    expect(check.status).toBe("warn");
    expect(check.label).toContain("NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY");
  });

  it("resolves env vars from .env.local before .env", async ({ expect }) => {
    const files = nextHappyFiles();
    // .env is missing the required project ID; .env.local supplies it.
    files[".env"] = `UNRELATED=1\n`;
    files[".env.local"] =
      `NEXT_PUBLIC_STACK_PROJECT_ID=p\n` +
      `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=k\n` +
      `STACK_SECRET_SERVER_KEY=s\n`;
    const dir = makeProject("env-precedence", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "env-vars");
    expect(check.status).toBe("pass");
  });

  it("skips config-file check when stack.config.ts is absent", async ({ expect }) => {
    const dir = makeProject("no-config", nextHappyFiles());
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "config-file");
    expect(check).toBeUndefined();
  });

  it("fails config-file check when config export is an array", async ({ expect }) => {
    const files = nextHappyFiles();
    files["stack.config.ts"] = "export const config = [];\n";
    const dir = makeProject("config-array", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "config-file");
    expect(check.status).toBe("fail");
    expect(check.label).toContain("not a plain object");
  });

  it("fails config-file check when there is no config export", async ({ expect }) => {
    const files = nextHappyFiles();
    files["stack.config.ts"] = "export const other = 1;\n";
    const dir = makeProject("config-missing", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "config-file");
    expect(check.status).toBe("fail");
    expect(check.label).toContain("missing a `config` export");
  });

  it("passes config-file check when config is a valid plain object", async ({ expect }) => {
    const files = nextHappyFiles();
    files["stack.config.ts"] = "export const config = { apps: { installed: {} } };\n";
    const dir = makeProject("config-ok", files);
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    const check = parsed.checks.find((c: any) => c.id === "config-file");
    expect(check.status).toBe("pass");
  });

  it("renders a human report with header and summary when --json is omitted", async ({ expect }) => {
    const dir = makeProject("human", nextHappyFiles());
    const { stdout, exitCode } = await runDoctor(["doctor", "--output-dir", dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hexclave doctor");
    expect(stdout).toMatch(/\d+ passed, \d+ failed/);
  });

  it("honors top-level --json flag (stack --json doctor)", async ({ expect }) => {
    const dir = makeProject("top-json", nextHappyFiles());
    const { stdout, exitCode } = await runDoctor(["--json", "doctor", "--output-dir", dir]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.framework).toBe("next");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
