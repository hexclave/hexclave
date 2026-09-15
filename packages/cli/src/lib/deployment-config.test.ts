import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectSecretDefaults, computeDeploymentLevels, evaluateDeploymentConfig, resolveDevEnv, type ServicesFunctionContext } from "./deployment-config.js";

const DEPLOY_FILE_PATH = path.join(path.sep, "repo", "hexclave.deploy.ts");

// Most tests care about the services, not the `deployment` wrapper, so they
// pass the services member alone and this puts it back in the envelope.
function evaluate(servicesExport: unknown, mode: "deploy" | "dev" = "deploy") {
  // Tests pass the services alone; this puts them back in the context-function
  // envelope the real export has.
  const deployExport = (context: ServicesFunctionContext) => ({
    services: typeof servicesExport === "function" ? (servicesExport as (ctx: ServicesFunctionContext) => unknown)(context) : servicesExport,
  });
  return evaluateDeploymentConfig({ deployFilePath: DEPLOY_FILE_PATH, deploymentGroupIdExport: "test-source", deployExport, mode });
}

// The same deploy file opted into a runtime with the internal `version` export.
function evaluateWithVersion(servicesExport: unknown, version: unknown, mode: "deploy" | "dev" = "deploy") {
  const deployExport = (context: ServicesFunctionContext) => ({
    services: typeof servicesExport === "function" ? (servicesExport as (ctx: ServicesFunctionContext) => unknown)(context) : servicesExport,
  });
  return evaluateDeploymentConfig({ deployFilePath: DEPLOY_FILE_PATH, deploymentGroupIdExport: "test-source", deployExport, versionExport: version, mode });
}
function evaluateOnGcp(servicesExport: unknown, mode: "deploy" | "dev" = "deploy") {
  return evaluateWithVersion(servicesExport, "gcp-beta-1", mode);
}

describe("evaluateDeploymentConfig (deploy mode)", () => {
  it("preserves __proto__ as an environment variable instead of mutating the result prototype", () => {
    const { services } = evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { ["__proto__"]: "safe" } },
    }));
    const definitionEnv = services.get("web")?.definition.env;
    expect(definitionEnv).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(definitionEnv ?? {}, "__proto__")).toBeDefined();
    expect(definitionEnv?.__proto__).toEqual({ value: "safe" });
  });

  it("serializes a full services export into wire-shape definitions", () => {
    const { services } = evaluate(({ isDev, secret, service, hexclave }: ServicesFunctionContext) => ({
      frontend: {
        type: "serverless",
        public: true,
        ports: { 3000: { protocol: "http" } },
        minInstances: 1,
        maxInstances: 3,
        devCommand: "pnpm dev",
        rootDirectory: "./apps/web",
        dockerfilePath: "./docker/Dockerfile.web",
        env: {
          DB_URL: (service("database") as any).url(),
          DB_INTERNAL: (service("database") as any).url(5432),
          OPENAI: isDev ? null : secret("OPENAI_API_KEY", "some-default"),
          REQUIRED_SECRET: secret("REQUIRED"),
          PROJECT_ID: (hexclave as any).projectId,
          PLAIN: "literal",
          OMITTED: null,
        },
      },
      database: { type: "serverless", ports: { 5432: { protocol: "http" } } },
    }));

    expect([...services.keys()]).toEqual(["frontend", "database"]);
    const frontend = services.get("frontend");
    expect(frontend?.definition).toEqual({
      type: "serverless",
      public: true,
      ports: { "3000": { protocol: "http" } },
      min_instances: 1,
      max_instances: 3,
      root_directory: "apps/web",
      // Authored relative to rootDirectory, joined onto it and normalized to a
      // posix path within the upload.
      dockerfile_path: "apps/web/docker/Dockerfile.web",
      env: {
        DB_URL: { type: "connection", value: "database.url" },
        DB_INTERNAL: { type: "connection", value: "database.url:5432" },
        // No default_value, even though OPENAI is declared with one: defaults
        // are never synced into a definition (see collectSecretDefaults).
        OPENAI: { type: "secret", key: "OPENAI_API_KEY" },
        REQUIRED_SECRET: { type: "secret", key: "REQUIRED" },
        PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
        PLAIN: { value: "literal" },
      },
    });
    expect(frontend?.absoluteRootDirectory).toBe(path.join(path.sep, "repo", "apps", "web"));
    // The dev command is read for local use only — `hexclave dev` gets it from
    // here, and it must never appear in the definition synced above.
    expect(frontend?.devCommand).toBe("pnpm dev");
    expect(frontend?.definition).not.toHaveProperty("dev_command");
    expect(services.get("database")?.definition.root_directory).toBe(".");
  });

  it("preserves explicit HTTP ports and defaults a service to private", () => {
    const { services } = evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } } } }));
    // The stored shape is the explicit record the author wrote.
    expect(services.get("web")?.definition.ports).toEqual({ "3000": { protocol: "http" } });
    expect(services.get("web")?.definition.public).toBe(false);
    const withPublic = evaluate(() => ({ web: { type: "serverless", public: true, ports: { 3000: { protocol: "http" } } } }));
    expect(withPublic.services.get("web")?.definition.public).toBe(true);
    // A private service may mix protocols freely.
    const multi = evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" }, 9090: { protocol: "tcp" } } } }));
    expect(multi.services.get("web")?.definition.ports).toEqual({
      "3000": { protocol: "http" },
      "9090": { protocol: "tcp" },
    });
  });

  it("reads memory from the ladder its service type actually has machines for", () => {
    const memoryOf = (service: unknown) => evaluate(() => ({ web: service })).services.get("web")?.definition.memory;
    expect(memoryOf({ type: "serverless", ports: {}, memory: "8GB" })).toBe("8GB");
    expect(memoryOf({ type: "server", ports: {}, memory: "4GB" })).toBe("4GB");
    // Absent stays absent rather than being written out as the default: the
    // backend normalizes an explicit default back out anyway, and a definition
    // that states what it already runs must not read differently from one that
    // says nothing.
    expect(memoryOf({ type: "serverless", ports: {} })).toBe(undefined);
    // The ladder is the RUNTIME's. On the default runtime a server may be 512MB (every Fly
    // service ran on that shape before sizes existed); on GCP no 512MB machine shape exists,
    // so the rung a serverless may use is not one a server may — and the error names the
    // ladder for THIS service on THIS runtime.
    expect(memoryOf({ type: "server", ports: {}, memory: "512MB" })).toBe("512MB");
    const badGcpMemory = (service: unknown) => () => evaluateOnGcp(() => ({ web: service }));
    expect(badGcpMemory({ type: "server", ports: {}, memory: "512MB" }))
      .toThrow(/deploy\.services\.web\.memory must be one of "1GB", "2GB", "4GB", "8GB"/);
    expect(evaluateOnGcp(() => ({ web: { type: "server", ports: {}, memory: "4GB" } })).services.get("web")?.definition.memory).toBe("4GB");
    // Sizes only the builder may ask for are not service sizes.
    const badMemory = (service: unknown) => () => evaluate(() => ({ web: service }));
    expect(badMemory({ type: "serverless", ports: {}, memory: "32GB" })).toThrow(/must be one of/);
  });

  it("refuses non-canonical memory spellings but says which one to write", () => {
    const memory = (value: unknown) => () => evaluate(() => ({ web: { type: "serverless", ports: {}, memory: value } }));
    // Recognising a spelling is not accepting it: one canonical token per size,
    // for the same reason a port key may not have a leading zero.
    expect(memory("4gb")).toThrow(/Write it as "4GB"/);
    expect(memory("4 GB")).toThrow(/Write it as "4GB"/);
    expect(memory("4Gi")).toThrow(/Write it as "4GB"/);
    expect(memory("4096MB")).toThrow(/Write it as "4GB"/);
    // "Mb" is megabits, so it is called out rather than silently accepted.
    expect(memory("512Mb")).toThrow(/megabits/);
    // Unrecognisable values fall back to naming the ladder.
    expect(memory("3GB")).toThrow(/must be one of/);
    expect(memory(4096)).toThrow(/must be one of/);
  });

  it("rejects port lists it could not serve", () => {
    const evaluatePorts = (ports: unknown) => () => evaluate(() => ({ web: { type: "serverless", ports } }));
    // The FIELD is still required — an omitted `ports` is a forgotten line far
    // more often than a deliberate worker, which writes `ports: {  }`.
    expect(evaluatePorts(undefined)).toThrow("has no `ports`");
    expect(evaluatePorts([{ port: 3000 }])).toThrow("must be an object keyed by port number");
    expect(evaluatePorts({ 3000: {} })).toThrow('.protocol is required and must be "http" or "tcp"');
    expect(evaluatePorts({ 3000: { transport: "http" } })).toThrow("unknown field");
    // The KEY is the port number, so a key that is not one is the error.
    expect(evaluatePorts({ web: {} })).toThrow("is not a port number");
    expect(evaluatePorts({ 70000: { protocol: "http" } })).toThrow("between 1 and 65535");
    expect(evaluatePorts({ 3000: "public" })).toThrow("must be an object");
    expect(evaluatePorts({ 3000: { public: true } })).toThrow('unknown field "public"');
    expect(evaluatePorts({ 5432: { protocol: "smtp" } })).toThrow('must be "http" or "tcp"');
    // A port numbered 80 or 443 beside the standard-ports holder asks for a
    // listener the holder already claims.
    expect(evaluatePorts({ 8080: { protocol: "http" }, 443: { protocol: "tcp" } })).toThrow("additionally answers on the standard 80 and 443");
    // One port, one spelling: "80" and "080" are different keys of one object but
    // the same port, so both would be declared. The record shape only rules out
    // an EXACT repeated key.
    expect(evaluatePorts({ "8080": { protocol: "http" }, "08080": { protocol: "http" } })).toThrow("leading zero");
    expect(evaluatePorts({ "08080": { protocol: "http" } })).toThrow("leading zero");
  });

  it("rejects public services the runtime could not serve", () => {
    const evaluateService = (service: unknown) => () => evaluate(() => ({ web: service }));
    // Several ports on a public service are fine — all of them are reachable.
    expect(evaluateService({ type: "serverless", public: true, ports: { 3000: { protocol: "http" }, 4000: { protocol: "http" } } })).not.toThrow();
    // ...but not when one is 80 or 443, which the holder already claims.
    expect(evaluateService({ type: "serverless", public: true, ports: { 80: { protocol: "http" }, 443: { protocol: "http" } } }))
      .toThrow("additionally answers on the standard 80 and 443");
    // The holder itself may be 80 or 443 — it is what owns them.
    expect(evaluateService({ type: "serverless", public: true, ports: { 80: { protocol: "http" }, 3000: { protocol: "http" } } })).not.toThrow();
    // Raw TCP carries no SNI or Host, so a shared public address cannot route it.
    expect(evaluateService({ type: "server", public: true, ports: { 5432: { protocol: "tcp" } } }))
      .toThrow('declares the "tcp" port');
    // A private service may declare TCP freely.
    expect(evaluateService({ type: "server", ports: { 5432: { protocol: "tcp" } } })).not.toThrow();
    // Public ingress with nothing to serve on it.
    expect(evaluateService({ type: "server", public: true, ports: {} })).toThrow("declares no ports");
    expect(evaluateService({ type: "serverless", public: "yes", ports: { 3000: { protocol: "http" } } })).toThrow("must be true or false");
  });

  it("accepts a portless worker", () => {
    // A queue consumer or cron that only dials out. It gets no URL of any kind.
    const { services } = evaluate(() => ({ worker: { type: "server", ports: {  }, env: {} } }));
    expect(services.get("worker")?.definition.ports).toEqual({});
  });

  it("rejects connections whose target ports cannot satisfy them", () => {
    const evaluateEnv = (target: unknown, read: (service: (id: string) => any) => unknown) => () =>
      evaluate(({ service }: ServicesFunctionContext) => ({
        web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: read(service as any) } },
        api: target,
      }));
    const tcpOnly = { type: "server", ports: { 5432: { protocol: "tcp" } } };
    const twoHttp = { type: "serverless", ports: { 8080: { protocol: "http" }, 9090: { protocol: "http" } } };
    const httpAndTcp = { type: "serverless", ports: { 8080: { protocol: "http" }, 5432: { protocol: "tcp" } } };

    // `url` needs something HTTP to serve. A PRIVATE http service is fine —
    // its URL arrives with a verified custom domain.
    expect(evaluateEnv(tcpOnly, (service) => service("api").url())).toThrow("declares only TCP ports");
    expect(evaluateEnv({ type: "serverless", ports: { 8080: { protocol: "http" } } }, (service) => service("api").url())).not.toThrow();

    // A bare url() needs exactly one HTTP port to be unambiguous.
    expect(evaluateEnv(twoHttp, (service) => service("api").url())).toThrow("ambiguous");
    // Naming the port resolves it.
    expect(evaluateEnv(twoHttp, (service) => service("api").url(9090))).not.toThrow();
    // A TCP sibling does not make the single HTTP port ambiguous.
    expect(evaluateEnv(httpAndTcp, (service) => service("api").url())).not.toThrow();

    // A named port must exist on the target and speak HTTP.
    expect(evaluateEnv(twoHttp, (service) => service("api").url(1234))).toThrow("does not declare that port");
    expect(evaluateEnv(httpAndTcp, (service) => service("api").url(5432))).toThrow("that port is TCP");
    expect(evaluateEnv(twoHttp, (service) => service("api").url("8080"))).toThrow("takes a port number");

    // There is no port output: a bare number needs no reference.
    expect(evaluateEnv(twoHttp, (service) => service("api").internalPort)).toThrow('has no output named "internalPort"');
    // Forgetting the call is the likely mistake, so it gets its own message.
    expect(evaluateEnv(twoHttp, (service) => service("api").url)).toThrow("without calling it");
    // hostname() names no port, so passing one is a mistake worth its own message.
    expect(evaluateEnv(twoHttp, (service) => service("api").hostname(8080))).toThrow("takes no arguments");
  });

  it("splits public and private work across services", () => {
    // The runtime's proxy listeners are per-app, not per-address, so a service is
    // public on all of its ports or none. Wanting one of each means two services.
    expect(() => evaluate(() => ({
      web: { type: "serverless", public: true, ports: { 3000: { protocol: "http" } } },
      metrics: { type: "serverless", ports: { 9090: { protocol: "http" }, 5432: { protocol: "tcp" } } },
    }))).not.toThrow();
  });

  it("makes a deploy dependency of every reference the runtime cannot answer up front", () => {
    // Which references wait depends on the RUNTIME (see connectionRequiresTargetDeployed).
    // On the default runtime a private url(<port>) and hostname() are name-derived and
    // known before anything runs, so they produce NO edge; on GCP both are the target's
    // runtime address, so a consumer put first would fail the deploy on an unresolved
    // ref, and every service output orders the deploy.
    const deployFile = ({ service }: ServicesFunctionContext) => ({
      web: {
        type: "serverless", public: true, ports: { 3000: { protocol: "http" } },
        env: { API: (service("api") as any).url(8080), DB_HOST: (service("db") as any).hostname() },
      },
      api: { type: "serverless", ports: { 8080: { protocol: "http" }, 9090: { protocol: "http" } } },
      db: { type: "server", ports: { 5432: { protocol: "tcp" } } },
    });
    const onFly = evaluate(deployFile);
    expect(computeDeploymentLevels(onFly.services, onFly.runtime)).toEqual([["web", "api", "db"]]);
    const onGcp = evaluateOnGcp(deployFile);
    expect(computeDeploymentLevels(onGcp.services, onGcp.runtime)).toEqual([["api", "db"], ["web"]]);

    // The accepted cost on GCP: two services that each read the other's address are a
    // real cycle there, because neither can go first. Reported as one, with the way out.
    // On the default runtime the same file deploys in one level.
    const mutual = ({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API: (service("api") as any).url(8080) } },
      api: { type: "serverless", ports: { 8080: { protocol: "http" } }, env: { WEB_HOST: (service("web") as any).hostname() } },
    });
    expect(computeDeploymentLevels(evaluate(mutual).services, "fly")).toEqual([["web", "api"]]);
    expect(() => computeDeploymentLevels(evaluateOnGcp(mutual).services, "gcp")).toThrow(/circular connection dependency/);

    // A public `url` was always a dependency, and still is.
    const publicUrl = evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API: (service("api") as any).url() } },
      api: { type: "serverless", public: true, ports: { 8080: { protocol: "http" } } },
    }));
    expect(computeDeploymentLevels(publicUrl.services, publicUrl.runtime)).toEqual([["api"], ["web"]]);
  });

  it("leaves references to services of other deployment sources to the backend", () => {
    // Service ids are unique across the project, so an id this file does not
    // define may well belong to another repository's deploy file. Only the
    // backend can tell that apart from a typo, so nothing is rejected here — and
    // the reference still serializes.
    const { services } = evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("elsewhere") as any).url(8080) } },
    }));
    expect(services.get("web")?.definition.env.X).toEqual({ type: "connection", value: "elsewhere.url:8080" });
  });

  it("rejects URL outputs from TCP services and exposes host and port instead", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { DATABASE_URL: (service("database") as any).url() } },
      database: { type: "serverless", ports: { 5432: { protocol: "tcp" } } },
    }))).toThrow("hostname() with an explicit port");

    const { services } = evaluate(({ service }: ServicesFunctionContext) => ({
      web: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        env: {
          DATABASE_HOST: (service("database") as any).hostname(),
          // The port is a literal: the author already wrote 5432 on the target,
          // and a bare number needs no reference to be correct.
          DATABASE_PORT: "5432",
        },
      },
      database: { type: "serverless", ports: { 5432: { protocol: "tcp" } } },
    }));
    expect(services.get("web")?.definition.env).toMatchObject({
      DATABASE_HOST: { type: "connection", value: "database.hostname" },
      DATABASE_PORT: { value: "5432" },
    });
  });

  it("rejects unknown outputs on service() with the available outputs", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("db") as any).ur } },
      db: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }))).toThrow('service("db") has no output named "ur". Available outputs: url, hostname.');
  });

  it("rejects string interpolation of references", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API: `${(service("db") as any).url()}/api` } },
      db: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }))).toThrow("cannot be embedded in a string");
    expect(() => evaluate(({ secret }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { AUTH: `Bearer ${secret("KEY", "v")}` } },
    }))).toThrow("cannot be embedded in a string");
    expect(() => evaluate(({ hexclave }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { P: `id-${(hexclave as any).projectId}` } },
    }))).toThrow("cannot be embedded in a string");
  });

  it("rejects unknown outputs on the hexclave context object", () => {
    expect(() => evaluate(({ hexclave }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (hexclave as any).projectid } },
    }))).toThrow('hexclave has no output named "projectid"');
  });

  it("rejects service(\"hexclave\")", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("hexclave") as any).url() } },
    }))).toThrow("use the `hexclave` context object instead");
  });

  it("rejects a self-referential address the runtime cannot answer up front", () => {
    // A public URL is produced by the service's own rollout on either runtime, so no
    // self-reference to it can resolve before the deploy that creates it finishes.
    const publicSelf = ({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", public: true, ports: { 3000: { protocol: "http" } }, env: { SELF: (service("web") as any).url(3000) } },
    });
    expect(() => evaluate(publicSelf)).toThrow("cannot exist before the service is deployed");
    expect(() => evaluateOnGcp(publicSelf)).toThrow("cannot exist before the service is deployed");
    // A private address is name-derived on the default runtime and known in advance, so a
    // service may name its own; on GCP nothing publishes such a record, so it blocks on the
    // real address like any other output — and would reach the deploy as an unresolvable ref.
    const privateSelf = ({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { SELF: (service("web") as any).url(3000), HOST: (service("web") as any).hostname() } },
    });
    expect(() => evaluate(privateSelf)).not.toThrow();
    expect(() => evaluateOnGcp(privateSelf)).toThrow("cannot exist before the service is deployed");
  });

  it("reads the internal `version` export, and refuses one it does not know", () => {
    const deployFile = () => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } } } });
    expect(evaluate(deployFile)).toMatchObject({ runtime: "fly", version: undefined });
    expect(evaluateOnGcp(deployFile)).toMatchObject({ runtime: "gcp", version: "gcp-beta-1" });
    // Refused rather than ignored: a typo in our own token must not silently deploy to the
    // default, and a stray export in someone's file must not silently mean anything.
    const withVersion = (version: unknown) => () => evaluateWithVersion(deployFile, version);
    expect(withVersion("gcp")).toThrow(/unknown `version` export "gcp"/);
    expect(withVersion("1.0.0")).toThrow(/gcp-beta-1/);
    expect(withVersion(1)).toThrow(/must be a string/);
  });

  it("rejects assigning the whole service() return instead of an output", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: service("db") } },
      db: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }))).toThrow("pick one of its outputs");
  });

  it("rejects services without type and with unknown types", () => {
    expect(() => evaluate(() => ({ web: { ports: { 3000: { protocol: "http" } } } }))).toThrow('has no `type`');
    expect(() => evaluate(() => ({ web: { type: "netlify" } }))).toThrow('type must be "server" or "serverless"');
  });

  it("rejects unknown service fields (typo protection)", () => {
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, buildCmd: "x" } }))).toThrow('unknown field "buildCmd"');
  });

  it("rejects non-string env values with the value's type", () => {
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { PORT: 3000 } } }))).toThrow("got number");
  });

  it("rejects invalid env var keys and secret keys", () => {
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { "1BAD": "x" } } }))).toThrow("invalid key");
    expect(() => evaluate(({ secret }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: secret("bad key") } },
    }))).toThrow("secret key");
  });

  it("rejects a missing services member", () => {
    expect(() => evaluate(undefined)).toThrow("returned no `services`");
  });

  it("rejects empty and non-record returns", () => {
    expect(() => evaluate(() => ({}))).toThrow("returned no services");
    expect(() => evaluate(() => [])).toThrow("must be a record of services keyed by service id");
  });

  it("rejects reserved and invalid service ids", () => {
    expect(() => evaluate(() => ({ hexclave: { type: "serverless", ports: { 3000: { protocol: "http" } } } }))).toThrow("reserved");
    expect(() => evaluate(() => ({ "-bad": { type: "serverless", ports: { 3000: { protocol: "http" } } } }))).toThrow("Invalid service id");
  });

  it("rejects root directories outside the deploy file's directory", () => {
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory: "../outside" } }))).toThrow("outside the directory containing the deploy file");
  });

  it("omits dockerfile_path when dockerfilePath is not set (Railpack auto-detection)", () => {
    const { services } = evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } } } }));
    expect(services.get("web")?.definition.dockerfile_path).toBeUndefined();
  });

  it("joins dockerfilePath onto the root directory", () => {
    // Authored relative to rootDirectory; what leaves the machine is a path
    // within the upload, which is what the builder resolves against /ctx.
    const { services } = evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory: "./apps/web", dockerfilePath: "Dockerfile" },
    }));
    expect(services.get("web")?.definition.dockerfile_path).toBe("apps/web/Dockerfile");
    // ...and the authored spelling is kept, so an error can quote the line the
    // author actually has to edit.
    expect(services.get("web")?.authoredDockerfilePath).toBe("Dockerfile");
  });

  it("leaves dockerfilePath alone when the root directory is the deploy file's own", () => {
    const { services } = evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfilePath: "./docker/Dockerfile" },
    }));
    expect(services.get("web")?.definition.dockerfile_path).toBe("docker/Dockerfile");
  });

  it("rejects dockerfilePath values escaping the root directory", () => {
    expect(() => evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfilePath: "../Dockerfile" },
    }))).toThrow("services.web.dockerfilePath must point to a file inside the service's root directory");
    expect(() => evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfilePath: "." },
    }))).toThrow("services.web.dockerfilePath must point to a file inside the service's root directory");
    // A Dockerfile ABOVE a nested service is no longer expressible: it would
    // escape the root directory, even though it is inside the upload.
    expect(() => evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, rootDirectory: "./apps/web", dockerfilePath: "../../Dockerfile" },
    }))).toThrow("services.web.dockerfilePath must point to a file inside the service's root directory");
  });
});

describe("prebuilt images", () => {
  it("normalizes the image and omits the source fields", () => {
    const { services } = evaluate(() => ({
      database: { type: "server", ports: { 5432: { protocol: "tcp" } }, image: "postgres:16" },
    }));
    const definition = services.get("database")?.definition;
    // Stored fully qualified, so the definition names what is actually pulled.
    expect(definition?.image).toBe("docker.io/library/postgres:16");
    // Not built from the upload, so a path within it would point at nothing —
    // unlike a source service, which always states its root directory.
    expect(definition?.root_directory).toBeUndefined();
    expect(definition?.dockerfile_path).toBeUndefined();
  });

  it("still resolves a local root directory for `hexclave dev`", () => {
    // `rootDirectory` may not be SET on an image service, but the dev command
    // has to run somewhere: the deploy file's own directory. That value is
    // local-only and never reaches the definition.
    const { services } = evaluate(() => ({
      database: { type: "server", ports: { 5432: { protocol: "tcp" } }, image: "postgres:16", devCommand: "docker compose up db" },
    }));
    expect(services.get("database")?.absoluteRootDirectory).toBe(path.join(path.sep, "repo"));
    expect(services.get("database")?.devCommand).toBe("docker compose up db");
  });

  it("rejects a service that names two things to build from", () => {
    // Each of them says what the build starts from, so a service that gave both
    // would leave the deploy with two answers.
    expect(() => evaluate(() => ({
      database: { type: "server", ports: {}, image: "postgres:16", dockerfilePath: "Dockerfile" },
    }))).toThrow(/both `image` and `dockerfilePath`/);
    // A root directory is only meaningful once something is BUILT from the
    // upload, which is what a build command makes true.
    expect(() => evaluate(() => ({
      database: { type: "server", ports: {}, image: "postgres:16", rootDirectory: "./database" },
    }))).toThrow(/both `image` and `rootDirectory`/);
    expect(() => evaluate(() => ({
      database: { type: "server", ports: {}, image: "postgres:16", rootDirectory: "./database", buildCommand: "make" },
    }))).not.toThrow();
  });

  it("makes an image a BASE once a build command is set", () => {
    const { services } = evaluate(() => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        image: "python:3.12-slim", rootDirectory: "./api",
        buildCommand: "pip install -r requirements.txt",
        startCommand: "python -m uvicorn main:app --host 0.0.0.0 --port 3000",
      },
    }));
    const definition = services.get("web")?.definition;
    expect(definition?.image).toBe("docker.io/library/python:3.12-slim");
    expect(definition?.build_command).toBe("pip install -r requirements.txt");
    expect(definition?.start_command).toBe("python -m uvicorn main:app --host 0.0.0.0 --port 3000");
    // The service IS built from the upload now, so it states where in it its
    // code lives — unlike an image service with nothing built on top.
    expect(definition?.root_directory).toBe("api");
  });

  it("rejects an image that names no version", () => {
    // A bare name means ":latest", which is the one reference guaranteed to
    // move under a service that holds a volume.
    expect(() => evaluate(() => ({
      database: { type: "server", ports: {}, image: "postgres" },
    }))).toThrow(/no tag or digest/);
    expect(() => evaluate(() => ({
      database: { type: "server", ports: {}, image: "Postgres:16" },
    }))).toThrow(/invalid repository path segment/);
  });
});

describe("persistent volumes", () => {
  function web(service: Record<string, unknown>) {
    return () => ({ web: { type: "server", ports: { 3000: { protocol: "http" } }, env: {}, ...service } });
  }

  it("serializes a persistent volume into the wire shape, converting sizeGb to size_gb", () => {
    const { services } = evaluate(web({ persistentVolumes: { data: { path: "/data", sizeGb: 10 } } }));
    expect(services.get("web")?.definition.persistent_volumes).toEqual({ data: { path: "/data", size_gb: 10 } });
  });

  it("leaves persistent_volumes absent when none are declared, including for an empty record", () => {
    expect(evaluate(web({})).services.get("web")?.definition.persistent_volumes).toBeUndefined();
    // An empty record must collapse to absent rather than `{}`: the revision is
    // hashed over the serialized definition downstream, so the two spellings
    // would otherwise be different revisions of an identical service.
    expect(evaluate(web({ persistentVolumes: {} })).services.get("web")?.definition.persistent_volumes).toBeUndefined();
  });

  it("allows the implied 0/1 bounds to be spelled out on a server", () => {
    // Scale-to-zero is the point of a server: a suspended machine keeps its
    // volume and Fly Proxy resumes it with the disk intact.
    expect(() => evaluate(web({ minInstances: 0, maxInstances: 1, persistentVolumes: { data: { path: "/data", sizeGb: 1 } } }))).not.toThrow();
  });

  it("rejects a persistent volume on a serverless service", () => {
    expect(() => evaluate(() => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, maxInstances: 2, persistentVolumes: { data: { path: "/data", sizeGb: 1 } } },
    }))).toThrow('declares persistentVolumes but is a "serverless" service');
  });

  it("rejects more than one persistent volume per service", () => {
    expect(() => evaluate(web({
      persistentVolumes: { data: { path: "/data", sizeGb: 1 }, cache: { path: "/cache", sizeGb: 1 } },
    }))).toThrow("only 1 per service is supported right now");
  });

  it("rejects the same volume id on two services", () => {
    // One id names one disk; two claimants would be asking Fly to mount it
    // twice, so this has to fail before anything is uploaded.
    expect(() => evaluate(() => ({
      web: { type: "server", ports: { 3000: { protocol: "http" } }, persistentVolumes: { shared: { path: "/data", sizeGb: 1 } } },
      worker: { type: "server", ports: { 3001: { protocol: "http" } }, persistentVolumes: { shared: { path: "/data", sizeGb: 1 } } },
    }))).toThrow('The persistent volume id "shared" is claimed by both');
  });

  it("rejects volume ids that cannot become Fly volume names", () => {
    for (const volumeId of ["Data", "1data", "my-volume", "_data", "x".repeat(27)]) {
      expect(() => evaluate(web({ persistentVolumes: { [volumeId]: { path: "/data", sizeGb: 1 } } })), `id ${JSON.stringify(volumeId)}`)
        .toThrow("Invalid persistent volume id");
    }
  });

  it("rejects mount paths that are not normalized absolute paths", () => {
    for (const volumePath of ["data", "/", "/data/", "/data/../etc", "/da\\ta"]) {
      expect(() => evaluate(web({ persistentVolumes: { data: { path: volumePath, sizeGb: 1 } } })), `path ${JSON.stringify(volumePath)}`)
        .toThrow("must be a normalized absolute path inside the container");
    }
  });

  it("rejects sizes outside the supported range and non-integer sizes", () => {
    expect(() => evaluate(web({ persistentVolumes: { data: { path: "/data", sizeGb: 0 } } }))).toThrow("must be between 1 and 500 GB");
    expect(() => evaluate(web({ persistentVolumes: { data: { path: "/data", sizeGb: 501 } } }))).toThrow("must be between 1 and 500 GB");
    expect(() => evaluate(web({ persistentVolumes: { data: { path: "/data", sizeGb: 1.5 } } }))).toThrow("whole number of gigabytes");
  });

  it("rejects a missing path or size, and unknown volume fields", () => {
    expect(() => evaluate(web({ persistentVolumes: { data: { sizeGb: 1 } } }))).toThrow("deploy.services.web.persistentVolumes.data.path is required");
    expect(() => evaluate(web({ persistentVolumes: { data: { path: "/data" } } }))).toThrow("deploy.services.web.persistentVolumes.data.sizeGb is required");
    expect(() => evaluate(web({ persistentVolumes: { data: { path: "/data", sizeGb: 1, size: 2 } } }))).toThrow('unknown field "size"');
    expect(() => evaluate(web({ persistentVolumes: "10gb" }))).toThrow("deploy.services.web.persistentVolumes must be an object");
    expect(() => evaluate(web({ persistentVolumes: { data: "10gb" } }))).toThrow("deploy.services.web.persistentVolumes.data must be an object");
  });
});

describe("service types", () => {
  it("pins a server to a single instance and defaults it to always-on", () => {
    expect(() => evaluate(() => ({ api: { type: "server", ports: { 3000: { protocol: "http" } }, maxInstances: 2 } })))
      .toThrow("maxInstances must be 1");
    // 0 (suspend when idle) and 1 (stay up) are the only meanings one instance
    // can have; the default is 1.
    expect(() => evaluate(() => ({ api: { type: "server", ports: { 3000: { protocol: "http" } }, minInstances: 2 } })))
      .toThrow("minInstances must be 1 (always on, the default) or 0");
    expect(evaluate(() => ({ api: { type: "server", ports: { 3000: { protocol: "http" } }, minInstances: 0 } })).services.get("api")?.definition.min_instances).toBe(0);
    const defaulted = evaluate(() => ({ api: { type: "server", ports: { 3000: { protocol: "http" } } } })).services.get("api")?.definition;
    expect(defaulted).toMatchObject({ type: "server", min_instances: 1 });
  });

  it("rejects a fleet larger than the cap, before anything is packaged", () => {
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, maxInstances: 11 } })))
      .toThrow("maxInstances must be between 1 and 10 (got 11)");
    expect(() => evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, minInstances: 11 } })))
      .toThrow("minInstances must be between 0 and 10 (got 11)");
    // The cap itself is legal — an off-by-one here would refuse the largest
    // fleet the platform allows.
    expect(evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, maxInstances: 10 } })).services.get("web")?.definition.max_instances).toBe(10);
  });

  it("leaves serverless bounds alone", () => {
    const { services } = evaluate(() => ({ web: { type: "serverless", ports: { 3000: { protocol: "http" } }, minInstances: 1, maxInstances: 5 } }));
    expect(services.get("web")?.definition).toMatchObject({ type: "serverless", min_instances: 1, max_instances: 5 });
  });

});

describe("the deployment envelope", () => {
  const evaluateExports = (deploymentGroupIdExport: unknown, deployExport: unknown) =>
    () => evaluateDeploymentConfig({ deployFilePath: DEPLOY_FILE_PATH, deploymentGroupIdExport, deployExport, mode: "deploy" });

  it("requires a deploymentGroupId export naming the deployment group", () => {
    const deployExport = () => ({ services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } } } } });
    expect(evaluateExports(undefined, deployExport)).toThrow("has no `deploymentGroupId` export");
    expect(evaluateExports(7, deployExport)).toThrow("must be a string");
    expect(evaluateExports("-nope", deployExport)).toThrow("Invalid deployment group id");
    expect(evaluateExports("backend", deployExport)().sourceId).toBe("backend");
    // Dots are legal: a group id appears in no reference, so nothing has to
    // parse one — and projects that predate the move of services out of
    // hexclave.config.ts still have a stored group named after that file.
    expect(evaluateExports("hexclave.config.ts", deployExport)().sourceId).toBe("hexclave.config.ts");
  });

  it("names the rename when the file still exports `id`", () => {
    const deployExport = () => ({ services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } } } } });
    const evaluateLegacy = (legacyIdExport: unknown, deploymentGroupIdExport?: unknown) =>
      () => evaluateDeploymentConfig({ deployFilePath: DEPLOY_FILE_PATH, deploymentGroupIdExport, legacyIdExport, deployExport, mode: "deploy" });

    // The old name is refused rather than ignored: deploying under a different
    // group id than the file names would tear down its services.
    expect(evaluateLegacy("backend")).toThrow('Rename it to `deploymentGroupId`, e.g. `export const deploymentGroupId = "backend";`');
    // Refused even alongside the new one, so a half-done rename can't deploy
    // under whichever export happened to win.
    expect(evaluateLegacy("backend", "backend")).toThrow("no longer supported");
    // A non-string `id` is still the rename, not a type complaint.
    expect(evaluateLegacy(7)).toThrow('export const deploymentGroupId = "backend";');
  });

  it("rejects a missing or malformed deploy export", () => {
    expect(evaluateExports("s", undefined)).toThrow("has no `deploy` export");
    // The context is where secret()/service()/hexclave come from, so a plain
    // object could never reach them.
    expect(evaluateExports("s", { services: {} })).toThrow("must be a function of the deployment context");
    expect(evaluateExports("s", () => ({}))).toThrow("returned no `services`");
    expect(evaluateExports("s", () => ({ services: {}, extra: 1 }))).toThrow('unknown field "extra"');
    expect(evaluateExports("s", () => Promise.resolve({ services: {} }))).toThrow("must be synchronous");
  });
});

describe("collectSecretDefaults", () => {
  function webServiceWithEnv(servicesExport: unknown) {
    const { services } = evaluate(servicesExport);
    const web = services.get("web");
    if (web === undefined) throw new Error("the services export under test must define a service named `web`");
    return web;
  }

  it("collects only secrets that declare a default, keyed by env var", () => {
    const web = webServiceWithEnv(({ secret, hexclave }: ServicesFunctionContext) => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: {
          WITH_DEFAULT: secret("OPENAI_API_KEY", "some-default"),
          WITHOUT_DEFAULT: secret("REQUIRED"),
          PLAIN: "literal",
          PROJECT_ID: (hexclave as any).projectId,
        },
      },
    }));
    expect(collectSecretDefaults(web)).toEqual({ WITH_DEFAULT: "some-default" });
  });

  it("keys by env var so one secret can have different defaults per var", () => {
    // The default belongs to the `secret()` CALL, not to the secret — two env
    // vars may fill from the same key with different fallbacks, which a
    // secret-key-keyed map would silently collapse.
    const web = webServiceWithEnv(({ secret }: ServicesFunctionContext) => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: {
          PRIMARY: secret("SHARED", "primary-default"),
          SECONDARY: secret("SHARED", "secondary-default"),
        },
      },
    }));
    expect(collectSecretDefaults(web)).toEqual({ PRIMARY: "primary-default", SECONDARY: "secondary-default" });
  });

  it("keeps an empty-string default, which is not the same as having none", () => {
    const web = webServiceWithEnv(({ secret }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { EMPTY: secret("MAYBE", ""), NONE: secret("OTHER") } },
    }));
    expect(collectSecretDefaults(web)).toEqual({ EMPTY: "" });
  });
});

describe("evaluateDeploymentConfig (dev mode)", () => {
  it("resolves secrets to their default value and omits service() connections", () => {
    const { services } = evaluate(({ isDev, secret, service }: ServicesFunctionContext) => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: {
          OPENAI: secret("OPENAI_API_KEY", "dev-default"),
          DB_URL: isDev ? null : (service("database") as any).url(),
          PLAIN: "x",
        },
      },
      database: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }), "dev");
    expect(resolveDevEnv(services.get("web") ?? (() => {
      throw new Error("web service missing");
    })(), {})).toEqual({
      OPENAI: "dev-default",
      PLAIN: "x",
    });
  });

  it("errors on secrets without a default value only when resolving the selected service", () => {
    // Evaluation itself succeeds — a default-less secret in an UNRELATED
    // service must not block `hexclave dev --service-id` for everything else.
    const { services } = evaluate(({ secret }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { PLAIN: "x" } },
      worker: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: secret("NO_DEFAULT") } },
    }), "dev");
    expect(resolveDevEnv(services.get("web") ?? (() => {
      throw new Error("web service missing");
    })(), {})).toEqual({ PLAIN: "x" });
    expect(() => resolveDevEnv(services.get("worker") ?? (() => {
      throw new Error("worker service missing");
    })(), {})).toThrow("has no default value, so it cannot be resolved during `hexclave dev`");
  });

  it("validates service() references in dev mode too", () => {
    // service() returns null in dev (the env var is omitted), but a typo'd id
    // must still fail — not lie dormant until the next deploy.
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: service("databsae") as never } },
      database: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }), "dev")).not.toThrow();
  });

  it("explains the isDev guard when service() output access crashes on null", () => {
    expect(() => evaluate(({ service }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { DB_URL: (service("database") as any).url() } },
      database: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }), "dev")).toThrow("service() returns null — guard connection values with isDev");
  });

  it("resolves hexclave outputs from the session env", () => {
    const { services } = evaluate(({ hexclave }: ServicesFunctionContext) => ({
      web: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        env: {
          PROJECT_ID: (hexclave as any).projectId,
          API_URL: (hexclave as any).apiUrl,
          JWKS: (hexclave as any).jwksUrl,
          PCK: (hexclave as any).publishableClientKey,
          SSK: (hexclave as any).secretServerKey,
        },
      },
    }), "dev");
    const sessionEnv = {
      HEXCLAVE_PROJECT_ID: "proj_123",
      HEXCLAVE_API_URL: "https://api.example.com/",
      HEXCLAVE_PUBLISHABLE_CLIENT_KEY: "pck_123",
      HEXCLAVE_SECRET_SERVER_KEY: "ssk_123",
    };
    expect(resolveDevEnv(services.get("web") ?? (() => {
      throw new Error("web service missing");
    })(), sessionEnv)).toEqual({
      PROJECT_ID: "proj_123",
      API_URL: "https://api.example.com/",
      JWKS: "https://api.example.com/api/v1/projects/proj_123/.well-known/jwks.json",
      PCK: "pck_123",
      SSK: "ssk_123",
    });
  });

  it("errors when the session env lacks a needed hexclave output", () => {
    const { services } = evaluate(({ hexclave }: ServicesFunctionContext) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { SSK: (hexclave as any).secretServerKey } },
    }), "dev");
    expect(() => resolveDevEnv(services.get("web") ?? (() => {
      throw new Error("web service missing");
    })(), {})).toThrow("did not provide HEXCLAVE_SECRET_SERVER_KEY");
  });
});

describe("computeDeploymentLevels", () => {
  const build = (definition: (ctx: ServicesFunctionContext) => unknown) => evaluate(definition as never).services;

  it("orders dependencies before dependents, independent services in one level", () => {
    const services = build(({ service }) => ({
      frontend: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { A: (service("backend") as any).url(), B: (service("database") as any).url() } },
      backend: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { DB: (service("database") as any).url() } },
      database: { type: "serverless", ports: { 3000: { protocol: "http" } } },
      docs: { type: "serverless", ports: { 3000: { protocol: "http" } } },
    }));
    expect(computeDeploymentLevels(services)).toEqual([["database", "docs"], ["backend"], ["frontend"]]);
  });

  it("ignores hexclave connections for ordering", () => {
    const services = build(({ hexclave }) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { P: (hexclave as any).projectId } },
    }));
    expect(computeDeploymentLevels(services)).toEqual([["web"]]);
  });

  it("does not treat a hexclave output reference as a cycle", () => {
    // `hexclave.*` comes from the managed service, which always exists, so it must not become
    // an edge. Self-references to a service's own address never reach here at all — they are
    // rejected during evaluation, since no rollout can produce an address it needs first.
    const services = build(({ hexclave }) => ({
      web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { PROJECT_ID: (hexclave as any).projectId } },
    }));
    expect(computeDeploymentLevels(services)).toEqual([["web"]]);
  });

  it("names the cycle on circular dependencies", () => {
    const services = build(({ service }) => ({
      a: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("b") as any).url() } },
      b: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("c") as any).url() } },
      c: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: (service("a") as any).url() } },
    }));
    expect(() => computeDeploymentLevels(services)).toThrow(/circular connection dependency: (a -> b -> c -> a|b -> c -> a -> b|c -> a -> b -> c)/);
  });
});

describe("build and start commands", () => {
  const web = (service: Record<string, unknown>) => () => ({
    web: { type: "serverless", ports: { 3000: { protocol: "http" } }, ...service },
  });

  it("carries both commands into the definition", () => {
    const { services } = evaluate(web({ buildCommand: "pnpm install && pnpm build", startCommand: "pnpm start" }));
    const definition = services.get("web")?.definition;
    expect(definition?.build_command).toBe("pnpm install && pnpm build");
    expect(definition?.start_command).toBe("pnpm start");
    // Neither of them is a dev command: that one stays on this machine.
    expect(services.get("web")?.devCommand).toBeUndefined();
  });

  it("requires a start command when there is no base to inherit one from", () => {
    // The Hexclave base image starts nothing, so the service would deploy, boot
    // and immediately exit — caught before anything is packaged.
    expect(() => evaluate(web({ buildCommand: "npm ci" }))).toThrow(/no `image` or `dockerfilePath`/);
    // A base that HAS a command of its own needs none.
    expect(() => evaluate(web({ buildCommand: "npm ci", image: "node:22-bookworm" }))).not.toThrow();
    expect(() => evaluate(web({ buildCommand: "npm ci", dockerfilePath: "Dockerfile" }))).not.toThrow();
    // ...and a start command on its own is always fine: it builds nothing.
    expect(() => evaluate(web({ startCommand: "node server.js" }))).not.toThrow();
  });

  it("rejects a command that is not a single line", () => {
    // It becomes a Dockerfile RUN and an argv entry downstream; a newline is a
    // structural character in both, so it is refused rather than escaped.
    expect(() => evaluate(web({ buildCommand: "npm ci\nrm -rf /", startCommand: "npm start" }))).toThrow(/buildCommand must be a single/);
    expect(() => evaluate(web({ startCommand: "npm\tstart" }))).toThrow(/startCommand must be a single/);
    expect(() => evaluate(web({ startCommand: "   " }))).toThrow(/startCommand must be a single/);
    expect(() => evaluate(web({ startCommand: "x".repeat(2049) }))).toThrow(/startCommand must be a single/);
  });

  it("rejects an unknown command field rather than silently dropping it", () => {
    expect(() => evaluate(web({ runCommand: "node server.js" }))).toThrow(/unknown field "runCommand"/);
  });
});

describe("the deploy export's builder", () => {
  const evaluateDeploy = (deployRaw: unknown) => evaluateDeploymentConfig({
    deployFilePath: DEPLOY_FILE_PATH,
    deploymentGroupIdExport: "test-source",
    deployExport: () => deployRaw,
    mode: "deploy",
  });
  const withServices = (extra: Record<string, unknown>) => ({
    services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } },
    ...extra,
  });

  it("is a sibling of services, because one machine builds them all", () => {
    expect(evaluateDeploy(withServices({ builder: { memory: "32GB" } })).builder).toEqual({ memory: "32GB" });
    // Its ladder starts where the service ladders stop: a builder is a transient
    // machine sized for a build, not for an idling service.
    expect(evaluateDeploy(withServices({ builder: { memory: "8GB" } })).builder).toEqual({ memory: "8GB" });
    expect(() => evaluateDeploy(withServices({ builder: { memory: "512MB" } }))).toThrow(/deploy\.builder\.memory of .* must be one of "8GB", "16GB", "32GB"/);
    expect(() => evaluateDeploy(withServices({ builder: { memory: "32gb" } }))).toThrow(/Write it as "32GB"/);
  });

  it("collapses an empty builder to no opinion at all", () => {
    // `{}` and absent both mean "let the deployment decide"; storing one as a
    // declaration would make them read differently downstream.
    expect(evaluateDeploy(withServices({})).builder).toBe(undefined);
    expect(evaluateDeploy(withServices({ builder: {} })).builder).toBe(undefined);
  });

  it("rejects fields neither half of the deploy export knows", () => {
    expect(() => evaluateDeploy(withServices({ builder: { cpu: 4 } }))).toThrow(/unknown field "cpu"/);
    expect(() => evaluateDeploy(withServices({ builder: "32GB" }))).toThrow(/must be an object/);
    // The top-level check now names both supported fields rather than just one.
    expect(() => evaluateDeploy(withServices({ builders: {} }))).toThrow(/unknown field "builders". Supported fields: services, builder/);
  });
});
