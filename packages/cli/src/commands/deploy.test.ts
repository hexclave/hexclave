import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateDeploymentConfig, importDeployModule, resolveDeployFilePath, type ServicesFunctionContext } from "../lib/deployment-config.js";
import { collectCiEnv, collectPublicUrls, collectRequiredSecretKeys, deploymentDashboardUrl, firstFailedService, packageAndUploadSource, type ServiceDeployResult } from "./deploy.js";

const TEST_AUTH = {
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  publishableClientKey: "pck_test",
  projectId: "project-test",
  secretServerKey: "ssk_test",
};

describe("deploy command helpers", () => {
  const tempDirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexclave-deploy-test-"));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers an explicit --deploy-file path", () => {
    const dir = makeTempDir();
    const deployFilePath = path.join(dir, "custom.deploy.ts");
    fs.writeFileSync(deployFilePath, "export const deploy = { services: {} };");
    expect(resolveDeployFilePath("custom.deploy.ts", dir)).toBe(deployFilePath);
  });

  it("errors when the explicit deploy file doesn't exist", () => {
    const dir = makeTempDir();
    expect(() => resolveDeployFilePath("missing.deploy.ts", dir)).toThrow("Deploy file not found");
  });

  it("auto-discovers hexclave.deploy.ts", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "hexclave.deploy.ts"), "export const deploy = { services: {} };");
    expect(resolveDeployFilePath(undefined, dir)).toBe(path.join(dir, "hexclave.deploy.ts"));
  });

  it("loads the author-facing deploy export from a deploy file", async () => {
    const dir = makeTempDir();
    const deployFilePath = path.join(dir, "hexclave.deploy.ts");
    fs.writeFileSync(deployFilePath, 'export const deploymentGroupId = "source"; export const deploy = () => ({ services: {} });');

    const deployModule = await importDeployModule(deployFilePath);
    expect(deployModule.deploymentGroupId).toBe("source");
    expect(deployModule.legacyId).toBeUndefined();
    expect(deployModule.deploy).toBeTypeOf("function");
  });

  // The deploy file is a different document from hexclave.config.ts, so a
  // project that has only the latter has nothing to deploy.
  it("errors when no deploy file is found", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "hexclave.config.ts"), "export const config = {};");
    expect(() => resolveDeployFilePath(undefined, dir)).toThrow("No deploy file found");
  });

  describe("collectCiEnv", () => {
    it("is empty outside CI", () => {
      expect(collectCiEnv({ PATH: "/usr/bin", HOME: "/home/me" })).toEqual({});
    });

    it("passes GitLab's own variables through", () => {
      expect(collectCiEnv({
        CI_COMMIT_SHA: "0123456789abcdef",
        CI_COMMIT_SHORT_SHA: "01234567",
        CI_COMMIT_REF_NAME: "feat/x",
        CI_COMMIT_BRANCH: "feat/x",
        CI_SERVER_URL: "https://gitlab.com",
        CI_PROJECT_PATH: "acme/app",
      })).toEqual({
        CI_COMMIT_SHA: "0123456789abcdef",
        CI_COMMIT_SHORT_SHA: "01234567",
        CI_COMMIT_REF_NAME: "feat/x",
        CI_COMMIT_BRANCH: "feat/x",
        CI_REPOSITORY_URL: "https://gitlab.com/acme/app.git",
      });
    });

    it("translates a GitHub Actions push", () => {
      // GITHUB_HEAD_REF is exported as an EMPTY string on a push, which is why
      // the ?? chains cannot be trusted with the raw environment: CI_COMMIT_REF_NAME
      // would come out blank instead of falling through to GITHUB_REF_NAME.
      expect(collectCiEnv({
        GITHUB_SHA: "0123456789abcdef",
        GITHUB_HEAD_REF: "",
        GITHUB_REF_NAME: "main",
        GITHUB_REF_TYPE: "branch",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/app",
      })).toEqual({
        CI_COMMIT_SHA: "0123456789abcdef",
        CI_COMMIT_SHORT_SHA: "01234567",
        CI_COMMIT_REF_NAME: "main",
        CI_COMMIT_BRANCH: "main",
        CI_REPOSITORY_URL: "https://github.com/acme/app.git",
      });
    });

    it("reports a GitHub Actions pull request's head branch, and no CI_COMMIT_BRANCH", () => {
      // GITHUB_REF_NAME is the merge ref on a pull request, so the commit is on
      // no branch of its own — naming one would point at something that isn't
      // what was built.
      expect(collectCiEnv({
        GITHUB_SHA: "0123456789abcdef",
        GITHUB_HEAD_REF: "feat/x",
        GITHUB_REF_NAME: "42/merge",
        GITHUB_REF_TYPE: "branch",
      })).toEqual({
        CI_COMMIT_SHA: "0123456789abcdef",
        CI_COMMIT_SHORT_SHA: "01234567",
        CI_COMMIT_REF_NAME: "feat/x",
      });
    });

    it("reports a GitHub Actions tag build as a tag", () => {
      expect(collectCiEnv({
        GITHUB_SHA: "0123456789abcdef",
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_REF_TYPE: "tag",
      })).toEqual({
        CI_COMMIT_SHA: "0123456789abcdef",
        CI_COMMIT_SHORT_SHA: "01234567",
        CI_COMMIT_REF_NAME: "v1.2.3",
        CI_COMMIT_TAG: "v1.2.3",
      });
    });

    it("lets an explicitly set CI_ variable win over the GitHub translation", () => {
      expect(collectCiEnv({
        CI_COMMIT_SHA: "handwritten",
        GITHUB_SHA: "0123456789abcdef",
      })).toMatchObject({ CI_COMMIT_SHA: "handwritten", CI_COMMIT_SHORT_SHA: "01234567" });
    });
  });

  it("returns one final URL for each successfully deployed public service", () => {
    const services = evaluateDeploymentConfig({
      deployFilePath: path.join(os.tmpdir(), "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        web: { type: "serverless", public: true, ports: { 3000: { protocol: "http" } } },
        worker: { type: "serverless", ports: { 3001: { protocol: "http" } } },
        failed: { type: "serverless", public: true, ports: { 3002: { protocol: "http" } } },
      } }),
      mode: "deploy",
    }).services;
    expect(collectPublicUrls(["web", "worker", "failed"], services, new Map([
      ["web", { serviceId: "web", status: "deployed", url: "https://web.fly.dev", error: null }],
      ["worker", { serviceId: "worker", status: "deployed", url: null, error: null }],
      ["failed", { serviceId: "failed", status: "failed", url: null, error: "failed" }],
    ]))).toEqual([{ serviceId: "web", url: "https://web.fly.dev" }]);
  });

  it("reports every public port of a multi-port service", () => {
    // The runtime returns ONE url for the service — the standard-ports holder's,
    // which is why it carries no port. Every other public port hangs off it by
    // number, and would otherwise appear nowhere the author looks.
    const services = evaluateDeploymentConfig({
      deployFilePath: path.join(os.tmpdir(), "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        // Declared high-first on purpose: the holder is the lowest port NUMBER,
        // not whichever key was written first.
        web: { type: "serverless", public: true, ports: { 8443: { protocol: "http" }, 3000: { protocol: "http" } } },
      } }),
      mode: "deploy",
    }).services;
    expect(collectPublicUrls(["web"], services, new Map([
      ["web", { serviceId: "web", status: "deployed", url: "https://web.fly.dev", error: null }],
    ]))).toEqual([
      { serviceId: "web", url: "https://web.fly.dev" },
      { serviceId: "web", url: "https://web.fly.dev:8443" },
    ]);
  });

  it("fails before upload when a declared dockerfilePath is not in the packaged source", async () => {
    // The pre-flight reads the actual TAR contents rather than the filesystem,
    // so a .dockerignore mistake fails here in seconds instead of minutes later
    // in a remote builder.
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>no dockerfile</h1>");
    const services = evaluateDeploymentConfig({
      deployFilePath: path.join(dir, "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfilePath: "Dockerfile" },
      } }),
      mode: "deploy",
    }).services;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(packageAndUploadSource({
      auth: TEST_AUTH,
      authHeaders: () => Promise.resolve({ authorization: "test" }),
      sourceRoot: dir,
      services,
    })).rejects.toThrow("there is no such file");
  });

  it("resolves a declared dockerfilePath against the service's root directory", async () => {
    // `dockerfilePath: "Dockerfile"` under `rootDirectory: "./apps/web"` means
    // apps/web/Dockerfile — the pre-flight and the remote builder both look for
    // it at that path within the upload, so a bare "Dockerfile" at the repo
    // root must NOT satisfy it.
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM nginx:alpine\n");
    fs.writeFileSync(path.join(dir, "apps", "web", "index.html"), "<h1>hi</h1>");
    const servicesOf = (rootDirectory: string) => evaluateDeploymentConfig({
      deployFilePath: path.join(dir, "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory, dockerfilePath: "Dockerfile" },
      } }),
      mode: "deploy",
    }).services;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const upload = (services: ReturnType<typeof servicesOf>) => packageAndUploadSource({
      auth: TEST_AUTH,
      authHeaders: () => Promise.resolve({ authorization: "test" }),
      sourceRoot: dir,
      services,
    });

    expect(servicesOf("./apps/web").get("web")?.definition.dockerfile_path).toBe("apps/web/Dockerfile");
    // The error names the authored value AND the path that was looked for.
    await expect(upload(servicesOf("./apps/web"))).rejects.toThrow(/dockerfilePath "Dockerfile" \(apps\/web\/Dockerfile/);
    // The same declaration at the root directory finds the root Dockerfile, so
    // it gets past the pre-flight and fails at the first network call instead.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(upload(servicesOf("./"))).rejects.not.toThrow(/dockerfilePath/);
  });

  it("pre-flights only the services this deploy ships", async () => {
    // The UPLOAD is still the whole tree — one deploy is one tarball — but a
    // `--service-id web` deploy must not fail over a sibling whose directory is
    // missing from a sparse checkout, since nothing is going to build it.
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "web"), { recursive: true });
    fs.writeFileSync(path.join(dir, "web", "index.html"), "<h1>hi</h1>");
    const services = evaluateDeploymentConfig({
      deployFilePath: path.join(dir, "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory: "./web" },
        // Declared, but its directory is not in this checkout at all.
        worker: { type: "serverless", ports: {}, rootDirectory: "./worker" },
      } }),
      mode: "deploy",
    }).services;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const upload = (deploySet?: string[]) => packageAndUploadSource({
      auth: TEST_AUTH,
      authHeaders: () => Promise.resolve({ authorization: "test" }),
      sourceRoot: dir,
      services,
      deploySet,
    });

    // Deploying everything still reports the missing root.
    await expect(upload()).rejects.toThrow(/worker declares rootDirectory/);
    // Deploying only `web` gets past the pre-flight and fails at the first
    // network call instead.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(upload(["web"])).rejects.not.toThrow(/rootDirectory/);
  });

  it("notes an ignored Dockerfile when no dockerfilePath is set", async () => {
    // A Dockerfile in the source is deliberately NOT picked up implicitly — but silently
    // ignoring it would be a trap, so the deploy must say what it is doing instead.
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM nginx:alpine\n");
    const services = evaluateDeploymentConfig({
      deployFilePath: path.join(dir, "hexclave.deploy.ts"),
      deploymentGroupIdExport: "test-source",
      deployExport: () => ({ services: {
        web: { type: "serverless", ports: { 3000: { protocol: "http" } } },
      } }),
      mode: "deploy",
    }).services;
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => logged.push(String(line)));
    // Fail at the first network call — the note is logged during packaging, before it.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    await expect(packageAndUploadSource({
      auth: TEST_AUTH,
      authHeaders: () => Promise.resolve({ authorization: "test" }),
      sourceRoot: dir,
      services,
    })).rejects.toThrow();
    expect(logged.some((line) => line.includes("Railpack auto-detection") && line.includes('dockerfilePath: "Dockerfile"'))).toBe(true);
  });
});

describe("collectRequiredSecretKeys", () => {
  const servicesOf = (definition: (ctx: ServicesFunctionContext) => unknown) => [...evaluateDeploymentConfig({
    deployFilePath: path.join(os.tmpdir(), "hexclave.deploy.ts"),
    deploymentGroupIdExport: "test-source",
    deployExport: (ctx: ServicesFunctionContext) => ({ services: definition(ctx) }),
    mode: "deploy",
  }).services.values()];

  it("collects only secrets without defaults, deduplicated and sorted", () => {
    const services = servicesOf(({ secret }) => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: {
          A: secret("zebra"),
          B: secret("alpha"),
          C: secret("zebra"),
          D: secret("with-default", "fallback"),
          E: "plain",
        },
      },
      api: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: { F: secret("alpha") },
      },
    }));
    expect(collectRequiredSecretKeys(services)).toEqual(["alpha", "zebra"]);
  });

  it("returns an empty list when every secret has a default", () => {
    const services = servicesOf(({ secret }) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { A: secret("k", "v") } },
    }));
    expect(collectRequiredSecretKeys(services)).toEqual([]);
  });
});

describe("the dashboard link a deploy prints", () => {
  const base = { dashboardUrl: "https://app.hexclave.com", projectId: "proj-1", deploymentId: "dep-1" };

  it("opens the deployment when no service is named", () => {
    expect(deploymentDashboardUrl(base))
      .toBe("https://app.hexclave.com/projects/proj-1/deployments?deploymentId=dep-1");
  });

  it("opens a service's build log when one failed", () => {
    // The whole point: a failed deploy's last line is one click from the log.
    expect(deploymentDashboardUrl({ ...base, serviceId: "web", buildLogs: true }))
      .toBe("https://app.hexclave.com/projects/proj-1/deployments?deploymentId=dep-1&serviceId=web&panel=build-logs");
  });

  it("names the service but not the build log when nothing was built", () => {
    // An all-prebuilt deploy starts no builder, so that tab has nothing in it.
    expect(deploymentDashboardUrl({ ...base, serviceId: "db", buildLogs: false }))
      .toBe("https://app.hexclave.com/projects/proj-1/deployments?deploymentId=dep-1&serviceId=db");
  });

  it("survives a configured dashboard URL with a trailing slash", () => {
    expect(deploymentDashboardUrl({ ...base, dashboardUrl: "https://app.example.com/" }))
      .toBe("https://app.example.com/projects/proj-1/deployments?deploymentId=dep-1");
  });

  it("keeps a base path, and does not let a query or fragment swallow the route", () => {
    // REGRESSION: interpolating the configured base put the whole route inside
    // its query string, so the link navigated nowhere. Same failure lib/app.ts's
    // onboardingUrlFor already guarded against.
    expect(deploymentDashboardUrl({ ...base, dashboardUrl: "https://app.example.com/console" }))
      .toBe("https://app.example.com/console/projects/proj-1/deployments?deploymentId=dep-1");
    expect(deploymentDashboardUrl({ ...base, dashboardUrl: "https://app.example.com/console?tenant=one#settings" }))
      .toBe("https://app.example.com/console/projects/proj-1/deployments?deploymentId=dep-1");
  });

  it("falls back rather than throwing on a dashboard URL that is not a URL", () => {
    // Configured values are unvalidated, and this is printed, never fetched.
    expect(deploymentDashboardUrl({ ...base, dashboardUrl: "not-a-url" }))
      .toBe("not-a-url/projects/proj-1/deployments?deploymentId=dep-1");
  });

  it("escapes ids rather than pasting them into the URL", () => {
    expect(deploymentDashboardUrl({ ...base, projectId: "a/b", deploymentId: "d e", serviceId: "s&t", buildLogs: true }))
      .toBe("https://app.hexclave.com/projects/a%2Fb/deployments?deploymentId=d+e&serviceId=s%26t&panel=build-logs");
  });
});

describe("which service a failed deploy points at", () => {
  const result = (serviceId: string, status: ServiceDeployResult["status"]): [string, ServiceDeployResult] =>
    [serviceId, { serviceId, status, url: null, error: null }];

  it("is the FIRST failure in deploy order, not the last", () => {
    // A level's failure skips everything after it, so later failures are
    // consequences and the first is the cause.
    const results = new Map([result("db", "deployed"), result("api", "failed"), result("web", "failed")]);
    expect(firstFailedService(["db", "api", "web"], results)).toBe("api");
  });

  it("is null when every service deployed", () => {
    const results = new Map([result("db", "deployed"), result("web", "deployed")]);
    expect(firstFailedService(["db", "web"], results)).toBeNull();
  });

  it("ignores a service that was skipped rather than failed", () => {
    // "skipped" means an earlier level failed first; that service has no log.
    const results = new Map([result("db", "deployed"), result("web", "skipped")]);
    expect(firstFailedService(["db", "web"], results)).toBeNull();
  });

  it("is null when the deploy set names a service with no result at all", () => {
    expect(firstFailedService(["web"], new Map())).toBeNull();
  });
});
