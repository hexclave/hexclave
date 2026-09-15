import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASE_IMAGE, MAX_BUILD_ENV_BYTES } from "./config.js";
import { buildEnvByteLength, buildHarnessScript, buildTimeEnv, createMockBuilder, generatedDockerfile, type BuildTarget } from "./builds.js";
import { providerFor } from "./provider.js";
import { deploymentLogRedactionValues, validateDeploymentRequest, validateServiceSpec } from "./services.js";
import { targetIsBuilt, targetUsesGeneratedDockerfile } from "./types.js";

// The mock builder needs only the webhook secret. The real GCP builder is covered by the
// Compute Engine startup-script and client tests, without provisioning a VM in unit tests.
vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  getConfig: () => ({ webhookSecret: "webhook-secret" }),
}));
vi.mock("./store.js", () => ({
  readSpec: async () => null,
}));

// The harness script itself only runs on a real GCP builder VM, so these tests pin its
// shape (both build modes, credential stripping, checksum verification) rather than its
// behavior — a regression here means the real builder changed in a way QA must re-verify.
describe("buildHarnessScript", () => {
  const script = buildHarnessScript();

  it("loops over the target manifest and branches per target on its Dockerfile", () => {
    // One machine builds every service of the deployment, reading a tab-separated
    // manifest — /bin/sh with no jq is why it is not JSON.
    // The tab comes from printf: POSIX sh does not expand \t inside double quotes, so a
    // literal IFS="\t" would split on backslash and the letter "t" instead of on tabs.
    expect(script).toContain(`TAB="$(printf '\\t')"`);
    expect(script).not.toContain('IFS="\\t"');
    // The line is read whole and cut by hand; the executed test below is what pins WHY.
    expect(script).toContain("while IFS= read -r TARGET_LINE; do");
    expect(script).toContain("done < /marshal-targets.tsv");
    // Three build kinds, selected by what Marshal injected for the target: a
    // generated Dockerfile, the author's own, or Railpack.
    expect(script).toContain('if [ -f "$GEN_DIR/Dockerfile" ]; then');
    expect(script).toContain('elif [ -n "$DOCKERFILE_PATH" ]; then');
    // The author's Dockerfile is built by name — from /ctx, or from the scratch
    // copy with the appended build command.
    expect(script).toContain('--opt "filename=$DOCKERFILE_NAME"');
    expect(script).toContain('DOCKERFILE_NAME="$DOCKERFILE_PATH"');
    // ${VAR:-} rather than $VAR: if the env var is ever dropped (empty values are the most
    // likely casualty of a serializer), `set -u` must not kill the script before fail()
    // can report — that failure mode is a silent 20-minute hang.
    expect(script).toContain('[ -n "${BUILDKIT_TMPFS_SIZE:-}" ]');
  });

  it("names the failing target and stops the whole build there", () => {
    // The deployment fails as a unit: the services after this one depend on it,
    // and the caller needs to know WHICH target died in a shared log.
    expect(script).toContain('fail "$SERVICE_KEY: docker build failed (see the build log above)"');
    expect(script).toContain('fail "$SERVICE_KEY: railpack build failed (see the build log above)"');
    // fail() exits, so nothing after it in the loop runs.
    expect(script).toMatch(/fail\(\) \{[\s\S]*exit 1/);
  });

  it("parses a manifest whose optional fields are empty, in a real /bin/sh", () => {
    // Executed rather than pattern-matched: the failure this guards against is a shell
    // semantic (a tab is IFS WHITE SPACE, so `read -r a b c d` collapses a run of tabs and
    // shifts every later field), which no assertion about the script's text would catch.
    // The parsing lines are lifted out of the REAL script, so a regression there fails here.
    const parseStart = script.indexOf(`TAB="$(printf`);
    const parseEnd = script.indexOf("[ -n \"$SERVICE_KEY\" ] || continue");
    expect(parseStart).toBeGreaterThan(-1);
    expect(parseEnd).toBeGreaterThan(parseStart);
    const parser = script.slice(parseStart, parseEnd);

    const manifestPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-manifest-")), "targets.tsv");
    fs.writeFileSync(manifestPath, [
      // Both optional fields set, then BOTH empty (Railpack from the upload root), then only
      // root_directory set — the case that shifted fields.
      "web\tus-central1-docker.pkg.dev/project/marshal/web:tag\tweb/Dockerfile\tapps/web",
      "api\tus-central1-docker.pkg.dev/project/marshal/api:tag\t\t",
      "db\tus-central1-docker.pkg.dev/project/marshal/db:tag\t\tservices/db",
      "",
    ].join("\n"));

    const output = execFileSync("/bin/sh", ["-c", `${parser}
  echo "[$SERVICE_KEY][$PUSH_TARGET][$DOCKERFILE_PATH][$ROOT_DIRECTORY]"
done < ${JSON.stringify(manifestPath)}`], { encoding: "utf8" });

    expect(output.trim().split("\n")).toEqual([
      "[web][us-central1-docker.pkg.dev/project/marshal/web:tag][web/Dockerfile][apps/web]",
      "[api][us-central1-docker.pkg.dev/project/marshal/api:tag][][]",
      "[db][us-central1-docker.pkg.dev/project/marshal/db:tag][][services/db]",
    ]);
  });

  it("reports one digest per target so the applies know which image is whose", () => {
    expect(script).toContain('DIGESTS="$DIGESTS\\"$SERVICE_KEY\\":\\"$DIGEST\\""');
    expect(script).toContain(`printf '{"targets":{%s}}' "$DIGESTS" > /tmp/result.json`);
    expect(script).toContain('fail "$SERVICE_KEY: the build produced no image digest"');
  });

  it("verifies the railpack CLI checksum before executing it", () => {
    expect(script).toContain("sha256sum -c");
    expect(script).toMatch(/sha256sum -c[^\n]*\n[^\n]*railpack/);
  });

  it("strips build credentials from the railpack prepare subshell", () => {
    expect(script).toContain("unset REGISTRY_AUTH_B64 WEBHOOK_TOKEN WEBHOOK_URL TARBALL_URL");
  });

  it("mounts a tmpfs for the buildkit snapshotter when sized", () => {
    // Without this, the overlayfs rootfs forces buildkit's native (full-copy) snapshotter
    // and large base-image extraction alone exceeds the build timeout (real-provider QA).
    expect(script).toContain("mount -t tmpfs");
    expect(script).toContain("/var/lib/buildkit");
  });
});

describe("buildHarnessScript build-time env", () => {
  const script = buildHarnessScript();

  it("offers every var to buildkit as a secret whose id is the var name", () => {
    // A secret mount is the channel that does NOT write the value into an image layer, so
    // it is the one every var gets in both build modes.
    expect(script).toContain("printf ' --secret id=%s,src=%s'");
    // Per target: the directory is the argument, so one service's values are never
    // offered to another's build.
    expect(script).toContain('set -- $(secret_args "$ENV_DIR")');
  });

  it("additionally passes build args for a Dockerfile build", () => {
    // An ARG is the only thing a Dockerfile can interpolate into a RUN that inlines values.
    expect(script).toContain('set -- "$@" --opt "build-arg:${f##*/}=$(cat "$f")"');
  });

  it("hands the env to railpack detection and mounts the same names for its frontend", () => {
    expect(script).toContain('set -- "$@" --env "${f##*/}=$(cat "$f")"');
    // The frontend keys its layer cache on this build arg; without it a changed secret
    // would silently reuse the layer built from the previous one.
    expect(script).toContain('--opt "build-arg:secrets-hash=$(secrets_hash "$ENV_DIR")"');
  });

  it("tolerates a build with no env at all", () => {
    // Absent var, absent directory, and present-but-empty directory all have to reach
    // buildctl with an empty argument list rather than an unbound-variable death under
    // `set -u` or a literal "dir/*" glob argument.
    expect(script).toContain('[ -d "$1" ] || return 0');
    expect(script).toContain('[ -f "$f" ] || continue');
    expect(script).toContain('if [ "$#" -gt 0 ]; then');
  });

  it("never echoes a value", () => {
    // The harness's stdout IS the build log. Values are read with cat into an argument,
    // never printed; the only things printed alongside them are names and paths.
    expect(script).not.toMatch(/echo[^\n]*\$\(cat "\$f"\)/);
  });
});

describe("buildTimeEnv", () => {
  it("takes plain values and drops refs", () => {
    // One channel: every declared var goes to the build AND the runtime, secrets included.
    // A ref is excluded only because it names an output that does not exist yet.
    expect(buildTimeEnv({
      PLAIN: { value: "keep-me" },
      SECRET: { value: "sk-also-keep-me" },
      CONNECTION: { ref: "api.internal_url" },
    })).toEqual({ CI: "true", PLAIN: "keep-me", SECRET: "sk-also-keep-me" });
  });

  it("sets CI=true, and lets a declared CI win", () => {
    // Every build is a non-interactive one, so the tools that read CI should see
    // it whether or not the deploy file says so — but a service that sets its
    // own value has said what it means and must keep it.
    expect(buildTimeEnv({})).toEqual({ CI: "true" });
    expect(buildTimeEnv({ CI: { value: "false" } })).toEqual({ CI: "false" });
  });

  it("measures keys and values in utf-8 bytes", () => {
    expect(buildEnvByteLength({ K: "é" })).toBe(3);
  });
});

describe("deploymentLogRedactionValues", () => {
  const deployment = (env: Record<string, { value: string }>) => ({
    id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    ns: "ns",
    targets: [{ service_key: "web", spec: { env } }],
  }) as any;

  it("scrubs tenant env values but never CI provenance", () => {
    // The CI values are the deploy's own commit, which is what the build log
    // exists to show. Scrubbing them would black out the revision the build
    // prints — and, because these are matched as plain substrings, an 8-hex
    // short sha would take every unrelated 8-hex run in the log with it.
    const values = deploymentLogRedactionValues(providerFor("gcp"), deployment({
      DATABASE_URL: { value: "postgres://user:hunter2@db:5432/app" },
      CI_COMMIT_SHA: { value: "0123456789abcdef0123456789abcdef01234567" },
      CI_COMMIT_SHORT_SHA: { value: "01234567" },
      CI_REPOSITORY_URL: { value: "https://github.com/acme/app.git" },
    }));
    expect(values).toContain("postgres://user:hunter2@db:5432/app");
    expect(values).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(values).not.toContain("01234567");
    expect(values).not.toContain("https://github.com/acme/app.git");
  });

  it("still scrubs a service's OWN env var that merely starts with CI", () => {
    // The exemption is the CI_ namespace the control plane admits for ci_env,
    // not "any name beginning with CI" — CIPHER_KEY is an ordinary secret.
    expect(deploymentLogRedactionValues(providerFor("gcp"), deployment({
      CIPHER_KEY: { value: "sk-cipher-key-value" },
    }))).toContain("sk-cipher-key-value");
  });
});

describe("createMockBuilder", () => {
  it("reports a hexadecimal digest per target, whatever the service is called", async () => {
    // parseBuildImages requires /^sha256:[a-f0-9]{64}$/, and a service key is free to
    // contain letters hex does not have — a digest built by pasting ids together fails
    // every mock deployment with "the build reported no image for <service>".
    const completions: { metadataJson: string | null }[] = [];
    const builder = createMockBuilder(async (options) => void completions.push(options));
    await builder.startBuild({
      ns: "ns",
      deploymentId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      uploadId: "00000000-0000-4000-8000-000000000001",
      targets: ["web", "api", "worker-queue"].map((serviceKey) => ({
        serviceKey, pushTarget: `us-central1-docker.pkg.dev/project/marshal/hx-test-ns-${serviceKey}:tag`, dockerfilePath: null, rootDirectory: null, baseImage: null, buildCommand: null, buildEnv: {},
      })),
      builderMemoryMb: null,
    }, { assertOwned: async () => {} } as any);
    await vi.waitFor(() => expect(completions.length).toBe(1));

    const digests = JSON.parse(completions[0].metadataJson ?? "{}").targets as Record<string, string>;
    expect(Object.keys(digests).sort()).toEqual(["api", "web", "worker-queue"]);
    for (const digest of Object.values(digests)) expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Deterministic and distinct: e2e asserts on stored image refs, and two services
    // sharing a digest would hide a mix-up in which image was applied where.
    expect(new Set(Object.values(digests)).size).toBe(3);
  });
});

describe("validateServiceSpec build env size", () => {
  const specWithEnv = (env: Record<string, unknown>) => ({
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
    source: { image: "registry.example.com/app@sha256:abc" },
    env,
  });

  it("rejects plain values that would not fit in the builder machine's configuration", () => {
    expect(() => validateServiceSpec(specWithEnv({ BLOB: { value: "x".repeat(MAX_BUILD_ENV_BYTES) } }))).toThrow(/over the .* limit/);
  });

  it("does not count refs, which never reach the builder", () => {
    const env: Record<string, unknown> = { BLOB: { value: "x".repeat(MAX_BUILD_ENV_BYTES - 100) } };
    for (let index = 0; index < 50; index++) env[`REF_${index}`] = { ref: "api.url:8080" };
    expect(() => validateServiceSpec(specWithEnv(env))).not.toThrow();
  });
});

describe("validateDeploymentRequest paths", () => {
  const request = (target: Record<string, unknown>) => ({
    upload_id: "00000000-0000-4000-8000-000000000001",
    targets: [{
      service_key: "web",
      spec: { config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } }, env: {} },
      ...target,
    }],
    order: [["web"]],
  });

  it("keeps a normalized relative dockerfile path and root directory", () => {
    const parsed = validateDeploymentRequest(request({ dockerfile_path: "docker/Dockerfile.web", root_directory: "apps/web" }));
    expect(parsed.targets[0]).toMatchObject({ dockerfile_path: "docker/Dockerfile.web", root_directory: "apps/web" });
  });

  it("omits both when not provided (Railpack mode, upload root)", () => {
    const parsed = validateDeploymentRequest(request({}));
    expect("dockerfile_path" in parsed.targets[0]).toBe(false);
    expect("root_directory" in parsed.targets[0]).toBe(false);
    // "." is the upload root written out, which is the same as saying nothing.
    expect("root_directory" in validateDeploymentRequest(request({ root_directory: "." })).targets[0]).toBe(false);
  });

  it("accepts a prebuilt image target and normalizes its reference", () => {
    // The upload must be OMITTED when nothing is built: an archive nothing can
    // build from would be consumed and copied for no reason.
    const parsed = validateDeploymentRequest({
      targets: [{
        service_key: "database",
        image: "postgres:16",
        spec: { config: { type: "server", min_instances: 1, max_instances: 1, ports: { "5432": { protocol: "tcp" } } }, env: {} },
      }],
      order: [["database"]],
    });
    expect(parsed.uploadId).toBe(null);
    expect(parsed.targets[0]).toMatchObject({ image: "docker.io/library/postgres:16" });
  });

  it("ties the upload to whether anything is actually built", () => {
    const prebuilt = {
      service_key: "database",
      image: "postgres:16",
      spec: { config: { type: "server", min_instances: 1, max_instances: 1, ports: { "5432": { protocol: "tcp" } } }, env: {} },
    };
    // An upload alongside an all-prebuilt deployment: the caller and the targets
    // disagree about what this deployment is, so it is refused rather than
    // silently stranded.
    expect(() => validateDeploymentRequest({
      upload_id: "00000000-0000-4000-8000-000000000001",
      targets: [prebuilt],
      order: [["database"]],
    })).toThrow(/upload_id must be omitted/);
    // ...and a source build without one cannot be built at all.
    expect(() => validateDeploymentRequest({
      targets: [{ service_key: "web", spec: { config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } }, env: {} } }],
      order: [["web"]],
    })).toThrow(/upload_id is required/);
    // A MIXED deployment builds something, so it still needs the upload.
    const mixed = validateDeploymentRequest({
      upload_id: "00000000-0000-4000-8000-000000000001",
      targets: [prebuilt, { service_key: "web", spec: { config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } }, env: {} } }],
      order: [["database"], ["web"]],
    });
    expect(mixed.uploadId).not.toBe(null);
  });

  it("refuses an image reference that would not name fixed bytes, or one that also builds", () => {
    const target = (extra: Record<string, unknown>) => () => validateDeploymentRequest({
      targets: [{
        service_key: "database",
        spec: { config: { type: "server", min_instances: 1, max_instances: 1, ports: {} }, env: {} },
        ...extra,
      }],
      order: [["database"]],
    });
    // The last line before the runtime is at least as strict as the layers above
    // it: an untagged image means ":latest", which moves.
    expect(target({ image: "postgres" })).toThrow(/explicit tag or digest/);
    expect(target({ image: "postgres:16@sha256:" + "a".repeat(64) })).toThrow(/tag or a digest, not both/);
    expect(target({ image: "https://ghcr.io/org/app:1" })).toThrow(/scheme/);
    // `image` and `dockerfile_path` each say what the build starts from.
    expect(target({ image: "postgres:16", dockerfile_path: "Dockerfile" })).toThrow(/names an image and a dockerfile_path/);
    // An image with no build command is not built from the upload at all, so a
    // directory within it means nothing — but WITH one it is a base, and the
    // root directory is where the command runs.
    expect(target({ image: "postgres:16", root_directory: "database" })).toThrow(/root_directory within it means nothing/);
    expect(() => validateDeploymentRequest(request({ image: "postgres:16", root_directory: "database", build_command: "make" }))).not.toThrow();
  });

  it("rejects paths that could escape or break the builder's manifest", () => {
    // Both fields reach the harness as TAB-separated manifest fields and as shell
    // variables, so a tab or a traversal segment is refused rather than escaped.
    for (const invalid of ["/abs/Dockerfile", "../Dockerfile", "a/../b", "a//b", "back\\slash", "tab\tchar", "x".repeat(513), 42]) {
      expect(() => validateDeploymentRequest(request({ dockerfile_path: invalid })), String(invalid)).toThrow(/dockerfile_path/);
      expect(() => validateDeploymentRequest(request({ root_directory: invalid })), String(invalid)).toThrow(/root_directory/);
    }
  });

  it("requires the order to list every target exactly once", () => {
    const base = request({});
    expect(() => validateDeploymentRequest({ ...base, order: [[]] })).toThrow(/every target exactly once/);
    expect(() => validateDeploymentRequest({ ...base, order: [["web"], ["web"]] })).toThrow(/every target exactly once/);
    expect(() => validateDeploymentRequest({ ...base, order: [["other"]] })).toThrow(/every target exactly once/);
  });

  it("rejects two targets naming one service", () => {
    const base = request({});
    expect(() => validateDeploymentRequest({ ...base, targets: [base.targets[0], base.targets[0]], order: [["web"]] }))
      .toThrow(/same service twice/);
  });

  it("validates each target's spec on THIS request rather than after the build", () => {
    // A five-minute build that ends in "your ports are invalid" is the failure
    // this exists to prevent.
    expect(() => validateDeploymentRequest(request({
      spec: { config: { type: "serverless", public: true, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } } }, env: {} },
    }))).toThrow(/may not declare a "tcp" port/);
  });
});

describe("build and start commands", () => {
  const spec = (extra: Record<string, unknown> = {}) => ({
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } }, ...extra },
    env: {},
  });
  const request = (target: Record<string, unknown>) => ({
    upload_id: "00000000-0000-4000-8000-000000000001",
    targets: [{ service_key: "web", spec: spec(), ...target }],
    order: [["web"]],
  });

  it("refuses a command that could not survive the file it is written into", () => {
    // A newline is a second Dockerfile instruction and a second argv entry; both
    // are refused rather than escaped, at the boundary that turns a request into
    // a build.
    for (const invalid of ["build\nrm -rf /", "build\ttab", "", "   ", "x".repeat(2049), 42]) {
      expect(() => validateDeploymentRequest(request({ build_command: invalid, image: "node:22" })), String(invalid))
        .toThrow(/build_command/);
      expect(() => validateDeploymentRequest({
        ...request({}),
        targets: [{ service_key: "web", spec: spec({ start_command: invalid }) }],
      }), String(invalid)).toThrow(/start_command/);
    }
  });

  it("requires a start command when the base image is Marshal's own", () => {
    // node:22-bookworm starts a REPL: a service built on it with nothing to run
    // would deploy, boot and exit.
    expect(() => validateDeploymentRequest(request({ build_command: "npm ci" })))
      .toThrow(/has no command of its own/);
    // A base that DOES have a command of its own needs none.
    expect(() => validateDeploymentRequest(request({ build_command: "npm ci", image: "node:22" }))).not.toThrow();
    expect(() => validateDeploymentRequest(request({ build_command: "npm ci", dockerfile_path: "Dockerfile" }))).not.toThrow();
    expect(() => validateDeploymentRequest({
      ...request({}),
      targets: [{ service_key: "web", build_command: "npm ci", spec: spec({ start_command: "npm start" }) }],
    })).not.toThrow();
  });

  it("counts an image with a build command as BUILT, so the deployment needs its upload", () => {
    // The whole point of the pairing: an image alone is not built, and adding a
    // build command turns it into a base — which means an upload, a builder
    // machine, and a build log.
    expect(() => validateDeploymentRequest({
      targets: [{ service_key: "db", image: "postgres:16", build_command: "make extensions", spec: spec() }],
      order: [["db"]],
    })).toThrow(/upload_id is required/);
    // ...while a START command alone leaves it prebuilt: it is applied by the
    // runtime, so it builds nothing.
    expect(() => validateDeploymentRequest({
      targets: [{ service_key: "db", image: "postgres:16", spec: spec({ start_command: "postgres -c fsync=off" }) }],
      order: [["db"]],
    })).not.toThrow();
  });
});

describe("generatedDockerfile", () => {
  const target = (extra: Partial<BuildTarget> = {}): BuildTarget => ({
    serviceKey: "web",
    pushTarget: "us-central1-docker.pkg.dev/project/marshal/web:tag",
    dockerfilePath: null,
    rootDirectory: null,
    baseImage: null,
    buildCommand: null,
    buildEnv: {},
    ...extra,
  });

  it("generates nothing for the builds that describe themselves", () => {
    // Railpack, and a plain Dockerfile build: the harness keys off the absence.
    expect(generatedDockerfile(target())).toBeNull();
    expect(generatedDockerfile(target({ dockerfilePath: "Dockerfile" }))).toBeNull();
  });

  it("copies the whole upload onto the base and runs the command in the root directory", () => {
    const generated = generatedDockerfile(target({
      baseImage: "docker.io/library/node:22-bookworm",
      rootDirectory: "apps/web",
      buildCommand: "pnpm install && pnpm build",
      buildEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com", B: "b" },
    }));
    expect(generated).toEqual({
      path: "Dockerfile",
      contents: [
        "FROM docker.io/library/node:22-bookworm",
        // One ARG per build-visible var, sorted: that is how the values reach
        // the command, and sorting keeps two builds of one target identical.
        "ARG B",
        "ARG NEXT_PUBLIC_API_URL",
        // The whole upload, so a monorepo service can reach shared code above
        // its own directory — the same rule the build context follows.
        "COPY . /app",
        "WORKDIR /app/apps/web",
        `RUN ["/bin/sh", "-c", "pnpm install && pnpm build"]`,
        "",
      ].join("\n"),
    });
  });

  it("leaves the working directory at the upload root when the service is the whole tree", () => {
    for (const rootDirectory of [null, ".", ""]) {
      const generated = generatedDockerfile(target({ baseImage: "base:1", rootDirectory, buildCommand: "make" }));
      expect(generated?.contents, String(rootDirectory)).toContain("WORKDIR /app\n");
    }
  });

  it("makes pnpm real on the runtime's own base image, and assumes nothing about anyone else's", () => {
    // node:22-bookworm ships corepack but no pnpm binary, so the promise that
    // pnpm is preinstalled is exactly one line — and it is only safe to make on
    // OUR image: `corepack enable` on a base without corepack would fail the
    // build before the author's command ever ran.
    expect(generatedDockerfile(target({ baseImage: BASE_IMAGE, buildCommand: "pnpm i" }))?.contents)
      .toContain("FROM " + BASE_IMAGE + "\nRUN corepack enable\n");
    expect(generatedDockerfile(target({ baseImage: "python:3.12-slim", buildCommand: "pip install ." }))?.contents)
      .not.toContain("corepack");
  });

  it("never bakes a start command into the image", () => {
    // The start command is machine configuration, applied as the machine's init,
    // so nothing about it belongs in a layer — an image built here starts
    // whatever its base started.
    const generated = generatedDockerfile(target({ baseImage: "base:1", buildCommand: "make" }));
    expect(generated?.contents).toBe("FROM base:1\nCOPY . /app\nWORKDIR /app\nRUN [\"/bin/sh\", \"-c\", \"make\"]\n");
    expect(generated?.contents).not.toContain("CMD");
    expect(generated?.contents).not.toContain("ENTRYPOINT");
  });

  it("declares the build env on the APPENDED path too, or the command cannot see it", () => {
    // `--opt build-arg:KEY=value` reaches a stage only if that stage declares
    // `ARG KEY`, and an author's own Dockerfile has no reason to have declared
    // Hexclave's variables — so without these lines the appended command would
    // silently build with every env var unset.
    const generated = generatedDockerfile(target({
      dockerfilePath: "Dockerfile",
      buildCommand: "npm run build",
      buildEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com", DATABASE_URL: "postgres://x" },
    }));
    expect(generated).toEqual({
      path: "suffix",
      contents: `\nARG DATABASE_URL\nARG NEXT_PUBLIC_API_URL\nRUN ["/bin/sh", "-c", "npm run build"]\n`,
    });
  });

  it("escapes a root directory the Dockerfile parser would otherwise expand", () => {
    // A WORKDIR expands variables, and the ARG lines just above put every
    // build-visible name in scope — so a directory really named `apps/$APP`
    // would resolve to something else, or to nothing.
    const generated = generatedDockerfile(target({
      baseImage: "base:1", rootDirectory: "apps/$APP", buildCommand: "make", buildEnv: { APP: "other" },
    }));
    expect(generated?.contents).toContain("WORKDIR /app/apps/\\$APP\n");
  });

  it("appends to the author's Dockerfile without gluing onto its last line", () => {
    // The leading newline is the point: the author's file is not guaranteed to
    // end in one.
    const generated = generatedDockerfile(target({ dockerfilePath: "Dockerfile", buildCommand: "npm run postbuild" }));
    expect(generated).toEqual({ path: "suffix", contents: `\nRUN ["/bin/sh", "-c", "npm run postbuild"]\n` });
  });

  it("encodes a command that would otherwise break the file it is written into", () => {
    // A quote, a backslash and a trailing `\` are all things shell-form RUN would
    // mangle (the last continues onto the next instruction). Exec form with JSON
    // encoding is what makes them ordinary characters.
    const generated = generatedDockerfile(target({ baseImage: "base:1", buildCommand: `echo "a\\b" && ls \\` }));
    expect(generated?.contents).toContain(`RUN ["/bin/sh", "-c", "echo \\"a\\\\b\\" && ls \\\\"]`);
    // One line, whatever the command contained.
    expect(generated?.contents.split("\n").filter((line) => line.startsWith("RUN")).length).toBe(1);
  });
});

describe("what a start command does NOT change", () => {
  const spec = (extra: Record<string, unknown> = {}) => ({
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } }, ...extra },
    env: {},
  });

  it("leaves an auto-detected build auto-detected", () => {
    // The whole reason the start command is applied by the runtime: saying "run
    // it this way" must not silently throw away the install and compile steps
    // Railpack was doing, which would build a clean image with no node_modules
    // in it and then fail at startup.
    //
    // Read off the VALIDATED target, so this covers the request shape a start
    // command actually arrives in rather than a hand-written struct.
    const [target] = validateDeploymentRequest({
      upload_id: "00000000-0000-4000-8000-000000000001",
      targets: [{ service_key: "web", spec: spec({ start_command: "npm start" }) }],
      order: [["web"]],
    }).targets;
    expect(target.spec.config.start_command).toBe("npm start");
    expect(targetIsBuilt(target)).toBe(true);
    expect(targetUsesGeneratedDockerfile(target)).toBe(false);
    // A BUILD command is what selects the generated Dockerfile.
    expect(targetUsesGeneratedDockerfile({ ...target, build_command: "npm ci" })).toBe(true);
  });
});
