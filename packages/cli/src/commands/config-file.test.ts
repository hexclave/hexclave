import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertConfigPullTarget, buildConfigPushSource, resolveConfigFilePathForPull } from "./config-file.js";
import { createConfigFileJiti } from "../lib/config-jiti.js";

describe("createConfigFileJiti", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexclave-cli-config-jiti-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The project has no node_modules, so every supported specifier — the
  // canonical SDK root, the deprecated `<pkg>/config` subpath, and legacy
  // `@stackframe/*` roots — must resolve to the CLI's bundled SDK copy.
  it.each([
    ["canonical root package", 'import { defineHexclaveConfig } from "@hexclave/js";', "defineHexclaveConfig"],
    ["deprecated /config subpath", 'import { defineHexclaveConfig } from "@hexclave/js/config";', "defineHexclaveConfig"],
    ["legacy @stackframe root", 'import { defineStackConfig } from "@stackframe/stack";', "defineStackConfig"],
  ])("loads config authoring imports from the %s when the project has no SDK installed", async (_label, importLine, defineFn) => {
    const configPath = path.join(tmpDir, "hexclave.config.ts");
    fs.writeFileSync(
      configPath,
      `${importLine}\nexport const config = ${defineFn}({ auth: { allowSignUp: true } });\n`,
    );

    const configModule = await createConfigFileJiti().import<{ config: { auth: { allowSignUp: boolean } } }>(configPath);

    expect(configModule.config).toEqual({ auth: { allowSignUp: true } });
  });
});

describe("resolveConfigFilePathForPull", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-config-pull-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the resolved --config-file path when provided", () => {
    const explicit = path.join(tmpDir, "nested", "config.ts");
    expect(resolveConfigFilePathForPull({ configFile: explicit }, tmpDir)).toBe(path.resolve(explicit));
  });

  it("rejects an explicit --config-file path that points to a directory", () => {
    expect(() => resolveConfigFilePathForPull({ configFile: tmpDir }, tmpDir)).toThrow(/must point to a config file/);
  });

  it("falls back to ./stack.config.ts in cwd when --config-file is omitted", () => {
    const expected = path.join(tmpDir, "stack.config.ts");
    fs.writeFileSync(expected, "// placeholder\n");
    expect(resolveConfigFilePathForPull({}, tmpDir)).toBe(expected);
  });

  it("rejects the default ./stack.config.ts path when it is a directory", () => {
    fs.mkdirSync(path.join(tmpDir, "stack.config.ts"));
    expect(() => resolveConfigFilePathForPull({}, tmpDir)).toThrow(/directory instead of a file/);
  });

  it("treats an empty --config-file string as omitted (falls back to cwd)", () => {
    const expected = path.join(tmpDir, "stack.config.ts");
    fs.writeFileSync(expected, "// placeholder\n");
    expect(resolveConfigFilePathForPull({ configFile: "" }, tmpDir)).toBe(expected);
  });

  it("defaults to ./hexclave.config.ts when neither --config-file nor cwd config file exists", () => {
    expect(resolveConfigFilePathForPull({}, tmpDir)).toBe(path.join(tmpDir, "hexclave.config.ts"));
  });
});

describe("assertConfigPullTarget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-cli-config-pull-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when the target file does not exist", () => {
    expect(() => assertConfigPullTarget(path.join(tmpDir, "hexclave.config.ts"), {})).not.toThrow();
  });

  it("throws when the target file already exists and --overwrite is not set", () => {
    const configPath = path.join(tmpDir, "hexclave.config.ts");
    fs.writeFileSync(configPath, "export const config = {};\n");
    expect(() => assertConfigPullTarget(configPath, {})).toThrow(/already exists.*--overwrite/s);
  });

  it("throws for an existing placeholder/comment-only file without --overwrite", () => {
    const configPath = path.join(tmpDir, "stack.config.ts");
    fs.writeFileSync(configPath, "// placeholder so the file exists\n");
    expect(() => assertConfigPullTarget(configPath, {})).toThrow(/already exists/);
  });

  it("does not throw when --overwrite is set, even if the file exists", () => {
    const configPath = path.join(tmpDir, "hexclave.config.ts");
    fs.writeFileSync(configPath, "export const config = {};\n");
    expect(() => assertConfigPullTarget(configPath, { overwrite: true })).not.toThrow();
  });
});

describe("buildConfigPushSource", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns pushed-from-unknown with no flags and no GitHub env vars", () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_REF_NAME;
    expect(buildConfigPushSource("stack.config.ts", {})).toEqual({ type: "pushed-from-unknown" });
  });

  it("auto-detects pushed-from-github from GitHub Actions env vars when no flags are set", () => {
    process.env.GITHUB_REPOSITORY = "myorg/my-repo";
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(buildConfigPushSource("stack.config.ts", {})).toEqual({
      type: "pushed-from-github",
      owner: "myorg",
      repo: "my-repo",
      branch: "main",
      commit_hash: "abc123",
      config_file_path: "stack.config.ts",
    });
  });

  it("builds pushed-from-github from --source flags", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "configs/stack.config.ts",
        sourceWorkflowPath: ".github/workflows/stack-auth-config-sync.yml",
      })
    ).toEqual({
      type: "pushed-from-github",
      owner: "myorg",
      repo: "my-repo",
      branch: "main",
      commit_hash: "abc123",
      config_file_path: "configs/stack.config.ts",
      workflow_path: ".github/workflows/stack-auth-config-sync.yml",
    });
  });

  it("rejects --source values other than 'github'", () => {
    expect(() =>
      buildConfigPushSource("stack.config.ts", { source: "gitlab" })
    ).toThrow(/Only 'github' is supported/);
  });

  it("requires all four flags together when --source github is set", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
      })
    ).toThrow(/--source-path.*--source-workflow-path/);
  });

  it("lists all three missing dependent flags when only --source github is passed", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", { source: "github" })
    ).toThrow(/--source-repo.*--source-path.*--source-workflow-path/);
  });

  it("treats empty-string --source-repo as malformed (not missing)", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrow(/owner\/repo/);
  });

  it("rejects empty-string --source-path", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-path must be a non-empty repo-relative path string.]`);
  });

  it("rejects empty-string --source-workflow-path", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: "",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-workflow-path must be a non-empty repo-relative path string.]`);
  });

  it("rejects whitespace-only --source-path", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "   ",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-path must be a non-empty repo-relative path string.]`);
  });

  it("rejects whitespace-only --source-workflow-path", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: "\t\n ",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-workflow-path must be a non-empty repo-relative path string.]`);
  });

  it("normalizes surrounding whitespace and leading repo-root markers from --source paths", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    const result = buildConfigPushSource("stack.config.ts", {
      source: "github",
      sourceRepo: "myorg/my-repo",
      sourcePath: "  ././configs/stack.config.ts  ",
      sourceWorkflowPath: " /.github/workflows/x.yml ",
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "branch": "main",
        "commit_hash": "abc123",
        "config_file_path": "configs/stack.config.ts",
        "owner": "myorg",
        "repo": "my-repo",
        "type": "pushed-from-github",
        "workflow_path": ".github/workflows/x.yml",
      }
    `);
  });

  it("rejects source paths that normalize to empty repo-relative paths", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "././",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-path must be a non-empty repo-relative path string.]`);
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: "/",
      })
    ).toThrowErrorMatchingInlineSnapshot(`[CliError: --source-workflow-path must be a non-empty repo-relative path string.]`);
  });

  it("rejects --source-repo with whitespace or invalid characters", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    const base = {
      source: "github" as const,
      sourcePath: "stack.config.ts",
      sourceWorkflowPath: ".github/workflows/x.yml",
    };
    expect(() => buildConfigPushSource("stack.config.ts", { ...base, sourceRepo: "myorg/my-repo " })).toThrow(/owner\/repo/);
    expect(() => buildConfigPushSource("stack.config.ts", { ...base, sourceRepo: " myorg/my-repo" })).toThrow(/owner\/repo/);
    expect(() => buildConfigPushSource("stack.config.ts", { ...base, sourceRepo: "my org/my-repo" })).toThrow(/owner\/repo/);
    expect(() => buildConfigPushSource("stack.config.ts", { ...base, sourceRepo: "myorg/my repo" })).toThrow(/owner\/repo/);
    expect(() => buildConfigPushSource("stack.config.ts", { ...base, sourceRepo: "myorg/my$repo" })).toThrow(/owner\/repo/);
  });

  it("rejects --source-repo without --source github", () => {
    expect(() =>
      buildConfigPushSource("stack.config.ts", { sourceRepo: "myorg/my-repo" })
    ).toThrow(/can only be used with --source github/);
  });

  it("rejects --source-path without --source github", () => {
    expect(() =>
      buildConfigPushSource("stack.config.ts", { sourcePath: "stack.config.ts" })
    ).toThrow(/can only be used with --source github/);
  });

  it("rejects --source-workflow-path without --source github", () => {
    expect(() =>
      buildConfigPushSource("stack.config.ts", { sourceWorkflowPath: ".github/workflows/x.yml" })
    ).toThrow(/can only be used with --source github/);
  });

  it("rejects malformed --source-repo", () => {
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "noslash",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrow(/owner\/repo/);
  });

  it("errors if GITHUB_SHA is missing when --source github is set", () => {
    delete process.env.GITHUB_SHA;
    process.env.GITHUB_REF_NAME = "main";
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrow(/GITHUB_SHA/);
  });

  it("errors if GITHUB_REF_NAME is missing when --source github is set", () => {
    process.env.GITHUB_SHA = "abc123";
    delete process.env.GITHUB_REF_NAME;
    expect(() =>
      buildConfigPushSource("stack.config.ts", {
        source: "github",
        sourceRepo: "myorg/my-repo",
        sourcePath: "stack.config.ts",
        sourceWorkflowPath: ".github/workflows/x.yml",
      })
    ).toThrow(/GITHUB_REF_NAME/);
  });
});
