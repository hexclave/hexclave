import { deindent } from "../../../utils/strings";

// The Deploy-specific addendum served at https://skill.hexclave.com/deployments.
// It is appended verbatim after the full base skill, so this section assumes the
// reader already has the general Hexclave skill (CLI auth, config format, SDKs) in
// context and only teaches what is specific to the Deploy app.
export const deploymentsSkillSection = deindent`
  # Hexclave Deploy

  The Deploy app runs your services as containers. A service is either BUILT remotely from your source — auto-detected with Railpack (https://railpack.com) by default, or from your own Dockerfile — or PULLED from a public image registry by naming an \`image\`, in which case nothing is built. You can define multiple services per Hexclave project (e.g. a backend and a frontend). Services are private by default and reach each other over an internal network. Mark a service \`public: true\` to give it a built-in public URL without requiring a custom domain.

  Every service is either a \`"server"\` or a \`"serverless"\`. A \`server\` is a single instance that SUSPENDS when idle and resumes with its memory intact, and it is the only type that may have a persistent disk. A \`serverless\` scales out between \`minInstances\` and \`maxInstances\` and STOPS on scale-down, so each start is a cold start and it can have no disk. Use \`server\` for anything stateful (a database, a queue, anything writing to a volume) and \`serverless\` for stateless web apps and APIs.

  Enable the app by adding \`"deploy"\` under \`apps.installed\` in your config (quote it — it contains a hyphen). Services themselves are NOT part of the \`config\` export and cannot be declared in \`hexclave.config.ts\`: they live in their own file, \`hexclave.deploy.ts\`, next to it.

  ## The deploy export

  \`\`\`ts title="hexclave.deploy.ts"
  import type { HexclaveDeploymentConfig } from "@hexclave/js";

  // Names this DEPLOYMENT GROUP: which deploy file these services come from.
  // Required, and unique across every deploy file deploying into this project.
  export const deploymentGroupId = "my-app";

  export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, service, hexclave }) => ({
    services: {
      web: {
        type: "serverless",
        public: true,
        ports: { 3000: { protocol: "http" } },
        devCommand: "pnpm dev",
        env: {
          MY_ENV_VAR: "true",
          OPENAI_API_KEY: isDev ? null : secret("OPENAI_API_KEY"),
          API_URL: isDev ? "http://localhost:3001" : service("api").url(8080),
          DATABASE_HOST: isDev ? "localhost" : service("database").hostname(),
          DATABASE_PORT: "5432",
        },
      },
      api: { type: "serverless", ports: { 8080: { protocol: "http" } }, rootDirectory: "./api", memory: "1GB" },
      cache: { type: "server", ports: { 6379: { protocol: "tcp" } }, image: "redis:7-alpine", minInstances: 0 },
      database: {
        type: "server",
        ports: { 5432: { protocol: "tcp" } },
        rootDirectory: "./database",
        dockerfilePath: "Dockerfile",
        persistentVolumes: { pgdata: { path: "/data", sizeGb: 10 } },
        memory: "4GB",
        env: { POSTGRES_PASSWORD: secret("POSTGRES_PASSWORD") },
      },
    },
    builder: { memory: "16GB" },
  });
  \`\`\`

  Always annotate the \`deploy\` export with \`HexclaveDeploymentConfig\`, imported as a type from \`@hexclave/js\` (the same type is re-exported from \`@hexclave/next\`, \`@hexclave/react\` and \`@hexclave/tanstack-start\`, so import from whichever SDK package this project already uses). It gives completion for every field below and catches typos before a deploy.

  The \`deploy\` export is a FUNCTION of the deployment context returning \`{ services, builder }\`. \`services\` is keyed by service id. \`type\` (required) is \`"server"\` or \`"serverless"\` as above. \`public\` (default false) is what exposes the service to the internet and gives it a stable platform URL; it is a property of the SERVICE, not of a port, because every port a service declares is served on every address it has. \`ports\` (required) is an object KEYED BY PORT NUMBER, and every non-empty entry must explicitly be \`{ protocol: "http" }\` or \`{ protocol: "tcp" }\`; use \`ports: {}\` for a worker that only dials out, which needs an always-on instance since nothing inbound can wake it (and cannot be \`public\`). A public service may declare several ports — each is reachable at its own port number, and the lowest additionally owns the standard 80/443, so it is the port the service's URL points at and the only one a custom domain can front. Only a PRIVATE service may declare TCP ports (a public address cannot route raw TCP), and a service with no HTTP port cannot have custom domains. \`rootDirectory\` (relative to the deploy file, default \`./\`) is where the service's code lives; \`dockerfilePath\` (optional, relative to \`rootDirectory\`) selects a Dockerfile to build from — omit it to build with Railpack auto-detection; \`image\` runs an already-built public image instead of building anything (\`"postgres:16"\`, \`"ghcr.io/org/app:1.2.3"\`), and is mutually exclusive with \`dockerfilePath\` — a tag is resolved when the image is pulled, so name a digest (\`"postgres@sha256:..."\`) if every deploy must run the same bytes; \`buildCommand\` and \`startCommand\` (both optional, single command lines run through \`sh -c\`) say how to build and how to start, and are described under Building below; \`minInstances\`/\`maxInstances\` (defaults: 1/1 for a server, 0/1 for a serverless; max 10) are the scaling bounds; \`memory\` sizes the container and is covered under Compute below; \`persistentVolumes\` (server only) attaches a persistent disk; \`devCommand\` is what \`hexclave dev --service-id <id>\` runs.

  A \`server\` holds exactly one instance: \`minInstances: 1\` (the default) keeps it up, and \`0\` lets it suspend when idle and resume with its memory intact. \`minInstances\` above 0 requires a paid plan for BOTH types — on the Free plan the deploy fails up front naming the offending services, so write \`minInstances: 0\` (note that a \`server\` needs it written out).

  Every service automatically receives \`HEXCLAVE_PROJECT_ID\`, \`HEXCLAVE_API_URL\`, \`HEXCLAVE_PUBLISHABLE_CLIENT_KEY\` and \`HEXCLAVE_SECRET_SERVER_KEY\`, plus \`NEXT_PUBLIC_\`/\`VITE_\` copies of the first three so client bundles can read them. An API key set is created for the project if it has none. Declaring an env var of the same name overrides the injected one.

  \`CI\` is \`"true"\` during every remote build. If \`hexclave deploy\` was itself run in CI, the GitLab-style \`CI_COMMIT_SHA\`, \`CI_COMMIT_SHORT_SHA\`, \`CI_COMMIT_REF_NAME\`, \`CI_COMMIT_BRANCH\`, \`CI_COMMIT_TAG\` and \`CI_REPOSITORY_URL\` are passed through to the service too (GitHub Actions' \`GITHUB_*\` are translated into the same names); one that nothing can answer is absent rather than empty. Declaring an env var of the same name overrides these as well.

  ## Network model: HTTP and private TCP

  Use the default HTTP protocol for web applications and APIs. \`service("api").url(8080)\` gives that port's URL — the service's PUBLIC url when the target service is public, and its internal address otherwise — and a bare \`url()\` requires exactly one HTTP port so it is unambiguous. \`service("api").hostname()\` is the private hostname without a port, and always works. There is no port output — write the number (e.g. \`DATABASE_PORT: "5432"\`), which you already declared in the target's \`ports\`. Service ids are unique across the whole project, so a service deployed from another repository is referenced exactly the same way. The process must listen on each configured port and bind to \`0.0.0.0\`.

  Use \`protocol: "tcp"\` on a port for a database, cache, queue, SMTP server, or other raw TCP daemon such as PostgreSQL, MySQL, Redis, or RabbitMQ. TCP ports are reachable only from other services in the same project: pass \`service("database").hostname()\` and the port as a literal, as separate env vars. Only a private service may declare TCP ports, and a service with no HTTP port exposes no \`url\` and cannot take custom domains. The daemon must bind to \`0.0.0.0\`, not only localhost. Do not manually change generated Fly infrastructure; Hexclave reconciliation owns it and can replace out-of-band changes.

  A service with \`minInstances: 0\` autostarts when a connection reaches its Flycast host and port. Make clients retry initial DNS/connect/auth failures with a bounded backoff: an HTTP app and its TCP dependency may be cold-starting simultaneously. If startup latency is unacceptable, use \`minInstances: 1\` on a paid plan.

  ## Compute: memory sizes the machine, and CPU comes with it

  \`memory\` sets how much memory a service gets, for either type: \`"512MB" | "1GB" | "2GB" | "4GB" | "8GB"\` (default \`"512MB"\`). Write the size with its unit and that exact capitalization — \`"4gb"\`, \`"4 GB"\` and \`"4Gi"\` are all rejected, and \`Mb\` means megabits. Anything above the default needs a paid plan, and a project may hold at most 32GB across its always-on services at once.

  There is no \`cpu\` setting: CPU is derived from memory, because the platform only offers valid machine shapes and a separately chosen CPU could name one that does not exist. Up to \`"2GB"\` a service runs on one SHARED, burstable vCPU; \`"4GB"\` gets two shared vCPUs; \`"8GB"\` is the first size with 2 dedicated cores, so a CPU-bound service wants \`"8GB"\` even when it fits in less memory.

  Changing \`memory\` restarts the service's machine with the new shape: a \`server\` is briefly unavailable (its persistent disk survives — the disk outlives the machine — so no data is lost), and a \`serverless\` is rolled one machine at a time. Resize a stateful server deliberately, not incidentally. Writing the size a service is ALREADY running at (\`memory: "512MB"\` on a service that has never set one) changes nothing and restarts nothing.

  \`builder\` sits beside \`services\`, not inside one, because one machine builds every service of a deploy: \`builder: { memory: "32GB" }\`, one of \`"8GB" | "16GB" | "32GB"\`. Leave it out and the build gets a machine sized for its shape (a larger one when the build is auto-detected by Railpack); a request below what the build shape needs is raised to it rather than refused. Raise it when a build is KILLED for running out of memory or disk — a large monorepo install, or a compiler that wants the whole project in memory. It does not affect what services run on; that is each service's own \`memory\`.

  ## Storage: the container filesystem is ephemeral

  By default anything a service writes to disk is lost on every deploy, restart, and scale-to-zero. Give a \`server\` service a persistent disk with \`persistentVolumes: { pgdata: { path: "/data", sizeGb: 10 } }\` — the key (\`pgdata\`) is the volume's id, \`path\` is an absolute mount point inside the container, \`sizeGb\` is gigabytes (1–500). Everything written under \`path\` then survives deploys and restarts. One disk per service for now; a second entry is rejected.

  The volume id names the disk within its service. Two services may never claim the same id at once. Moving an id to a different service does NOT move the data: a Fly volume lives inside one service's app, so the new service gets a fresh empty disk and the old one keeps its data, detached and still billed. Renaming a service does the same thing. To move data, copy it out (object storage, a database dump) before the move and restore it after.

  A volume mount replaces whatever the image had at that exact path, and a newly formatted filesystem is not guaranteed to be literally empty (it may contain provider/filesystem metadata). Prefer a neutral mount point such as \`/data\`, then configure the application to store its files in a child directory such as \`/data/app\`; do not mount directly over an image's built-in data/config directory or point software that requires an empty directory at the mount root.

  The container's runtime user must also be able to write to the mounted filesystem. In a Dockerfile, explicitly end with the intended non-root \`USER\`, make the mount point owned by that user in the image, and configure the application/entrypoint to create its child data directory. Do not assume an entrypoint will run as root and repair permissions after the volume is mounted. For a third-party image, inspect its user and data-directory requirements first; if they are incompatible, derive a small Dockerfile that establishes an explicit writable user/path rather than patching the running machine after deployment.

  For example, keep PostgreSQL's data in a child of the neutral mount and make the runtime user explicit:

  \`\`\`dockerfile title="database/Dockerfile"
  FROM postgres:17-alpine
  USER root
  RUN mkdir -p /data && chown postgres:postgres /data
  ENV PGDATA=/data/postgres
  USER postgres
  \`\`\`

  Apply the same pattern generically: learn the base image's intended runtime user and data-directory environment setting; create and own a neutral mount point; configure data into a child directory; and leave the final \`USER\` set correctly. Never bake mutable data into the image path that the volume will cover.

  A volume is a single disk on a single machine, which is why only a \`server\` may have one — a \`serverless\` fleet would give each instance its own separate copy. It is NOT replicated and NOT a backup; a host failure can lose it. Use it for caches, uploads, SQLite, and similar — keep anything you cannot lose in a managed database or object storage.

  Disks only grow: raising \`sizeGb\` expands them in place, but LOWERING it fails the deploy rather than silently ignoring you. Removing a volume from a service detaches the disk without deleting it — the data stays (re-declaring the same id remounts it) and so does the billing, so a disk you truly want gone has to be deleted deliberately. \`hexclave dev\` ignores \`persistentVolumes\` entirely; locally your app just writes to your own filesystem.

  Env var values may be: a plain string; \`null\` (omit the var — useful with \`isDev\`); \`secret(key, defaultValue?)\` — the value is stored per project in the dashboard (Project Settings > Secrets), never in the config; \`service("<id>").url(8080)\` for an HTTP port — a reference to a PRIVATE service resolves to its internal URL, which is available immediately, while one to a PUBLIC service resolves to the platform URL (or a verified custom domain) and so waits for the target to be up; \`service("<id>").hostname()\` for either protocol, always available (pair it with a literal port for TCP clients); or \`hexclave.projectId\` / \`.apiUrl\` / \`.jwksUrl\` / \`.publishableClientKey\` / \`.secretServerKey\` for the managed Hexclave backend. A target with no HTTP port has no URL, so \`url()\` on it fails with guidance to use hostname and port, as does a bare \`url()\` on a target whose several HTTP ports make it ambiguous. References must be the WHOLE value — string interpolation with them throws. During \`hexclave dev\`, \`secret()\` resolves to its default value (error if it has none and isn't guarded by \`isDev\`) and \`service()\` returns \`null\`.

  ## How services are built

  Each service is built remotely — Docker is never required locally. By default (no \`dockerfilePath\`) the build is auto-detected with [Railpack](https://railpack.com), which handles Node, Python, Go, PHP, Java, Ruby, and more out of the box; either way, the image's default command must start a server listening on each configured port on \`0.0.0.0\` and speaking that port's protocol. Set \`dockerfilePath\` to build from your own Dockerfile instead — a Dockerfile in the source is deliberately NOT picked up unless \`dockerfilePath\` names it. A service with an \`image\` and no \`buildCommand\` is not built at all: nothing is uploaded for it and its deploy takes seconds. A tag is resolved when the image is pulled, so redeploying an unchanged tag rolls nothing and a moved tag lands only when something else changes the service — name a digest to fix the bytes. The reference must carry an explicit tag or digest either way — a bare \`"postgres"\` means \`:latest\`, which changes under you. Use it for a third-party server you run unmodified, like the \`redis:7-alpine\` cache above; a service that mounts a PERSISTENT VOLUME usually still needs its own small Dockerfile, because the image's data directory has to be moved under the mount point (see Storage below). To adjust Railpack's detection (custom install/build/start commands, static output dirs), add a \`railpack.json\` to the service's source, or set the equivalent \`RAILPACK_*\` env var on the service. If detection can't work at all, add a Dockerfile and set \`dockerfilePath\`; the remote build's logs are available if a build fails.

  \`buildCommand\` and \`startCommand\` are the other way to say it, without a Dockerfile. \`startCommand\` is what the container runs INSTEAD of whatever its image would have started; it is applied when the container starts rather than baked into the image, so it costs no build, works on every kind of service (a Railpack-built one keeps its auto-detected build and just starts differently), and changing only it restarts the service without rebuilding. \`buildCommand\` runs while the image is built, and what it builds ON depends on the rest of the service: with an \`image\`, that image becomes the BASE — your source is copied to \`/app\`, the command runs in your \`rootDirectory\`, and the service is now built and uploaded like any other; with a \`dockerfilePath\`, it is appended to your Dockerfile as a final \`RUN\` and nothing is copied in that your Dockerfile did not copy itself; with neither, it builds on the Hexclave base image (Debian-based, with node, npm, pnpm, yarn, git and a C toolchain preinstalled) and REPLACES Railpack auto-detection entirely — nothing is inferred, so \`startCommand\` is required there. Both are single command lines run through \`sh -c\`: chain steps with \`&&\` rather than writing a script inline. Every env var is available to a \`buildCommand\` exactly as in a Railpack build. Prefer plain Railpack (or a Dockerfile) when it already works — these are for the cases where detection guesses wrong or there is nothing to detect.

  ## Env vars during the build

  A service's env vars are readable during the remote build as well as at runtime — you do not declare them twice, and secrets are not withheld from the build. That is what lets a framework that INLINES values at compile time (\`NEXT_PUBLIC_*\` for Next.js, \`VITE_*\` for Vite, and their equivalents) see them. Two consequences worth understanding: an inlined value is copied into the JavaScript your users download, permanently and by construction, so a var whose name starts with a public prefix must never hold a secret; and \`service(...)\` connection values are the one thing a build cannot see, because the target service has no address until it is rolled out — read those at runtime only.

  With a \`dockerfilePath\`, nothing reaches your build automatically: declare \`ARG MY_VAR\` to receive one (needed when a framework must inline it), or read it without baking it into a layer with \`RUN --mount=type=secret,id=MY_VAR\`, which is what anything sensitive should use. Railpack builds need neither — every var is already exported into each build step. Changing only an env var deploys the new value to the running containers but does NOT rebuild the image, so an inlined value keeps whatever it was compiled with until the next source deploy. A service with an \`image\` has no build at all, so its env vars are runtime-only — a framework that inlines values at build time needs a source build.

  A successful image build only proves that the image was produced; it does not prove that the service can boot, listen on its configured ports, reach its dependencies, or read/write its volume. After every first deploy or infrastructure change, request a real application endpoint and exercise at least one dependency-backed operation. For services with \`minInstances: 0\`, make dependency connection startup retry-safe: the application and a dependency can cold-start at the same time, so fail-fast one-shot connection initialization can turn a healthy cold start into a 500.

  ## Secrets

  Secret values are write-only, stored per project, and read server-side at deploy time. Humans set them in the dashboard under Project Settings > Secrets; agents set them via \`exec\`:

  \`\`\`sh title="Terminal"
  npx @hexclave/cli@latest exec --cloud-project-id <project-id> \\
    "const p = await hexclaveServerApp.getProject(); \\
     await p.setProjectSecret('OPENAI_API_KEY', process.env.OPENAI_API_KEY);"
  \`\`\`

  \`listProjectSecrets()\` returns keys and timestamps only — values can never be read back, and the dashboard lists only keys that have a value. \`defaultValue\` lives purely in the deploy file: it is sent with the deploy and never stored, so it never shows up as a set secret. A deploy fails up front and names every \`secret()\` without a default that has no stored value. Note that \`exec\` requires a \`hexclave login\` session — a server-key-only environment (typical CI) can DEPLOY using stored secrets but cannot SET them; set secrets beforehand from a logged-in machine or the dashboard.

  ## Agent workflow (do this — do not drive the dashboard UI)

  AI agents must deploy and manage Deploy through the CLI and \`hexclave.deploy.ts\`, not by clicking around \`app.hexclave.com\` in a browser. The dashboard is a human fallback only.

  1. **Read this skill** and ensure \`deploy\` is enabled and the \`deploy\` export exists as above.
  2. **Authenticate for cloud deploys** (pick the first that works):
     - If \`HEXCLAVE_SECRET_SERVER_KEY\` (or \`STACK_SECRET_SERVER_KEY\`) **and** \`HEXCLAVE_PROJECT_ID\` (or \`STACK_PROJECT_ID\`) are already in the environment, use them. No login step.
     - Else if \`npx @hexclave/cli@latest whoami\` succeeds, you already have a CLI login session — proceed.
     - Else confirm with the user first, then run \`npx @hexclave/cli@latest login\` yourself. It does not open a browser — it prints a one-time confirmation URL (\`https://app.hexclave.com/handler/cli-auth-confirm?login_code=...\`) and waits. Either open that URL in the user's browser or hand it to them to open, but either way tell them to complete the login themselves; you can't do it for them. Once the command returns successfully, continue immediately with the CLI. Do **not** use the browser yourself to open the Deploy dashboard or configure anything in the UI.
  3. **Set any needed secrets** (previous section), then **deploy** (next section).

  \`deploy\` auth: \`HEXCLAVE_SECRET_SERVER_KEY\` if set, otherwise the \`hexclave login\` session. \`exec --cloud-project-id\` needs the login session (not the secret server key alone).

  ## Deploying

  From the directory containing your deploy file:

  \`\`\`sh title="Terminal"
  npx @hexclave/cli@latest deploy
  \`\`\`

  This syncs the service definitions, uploads the deploy file's directory ONCE (respecting \`.gitignore\`/\`.dockerignore\`, always excluding \`node_modules\` and \`.git\`), builds every service THAT IS BUILT FROM SOURCE in a single remote builder — so Docker is not needed locally — and then rolls them out in dependency order (services connected via \`service(...)\` deploy after their dependencies; circular dependencies fail up front). A build failure fails the whole deploy and ships nothing: one machine builds every image, so there is no half-built source to salvage. Services with an \`image\` take no part in any of that — if EVERY service has one, nothing is uploaded, no builder runs, and the deploy has no build logs to read. It always targets production, never prompts, and WAITS — streaming the remote build's output and printing each service's status and final URL as it lands — and exits non-zero if the deploy fails. A JSON summary is printed to stdout.

  A sync is the whole truth about its own deploy file: a service you REMOVE from \`services\` is torn down on the next deploy, keeping its persistent volume and any custom domain (unattached) so a config edit can never destroy data. Services of other deployment sources are never touched.

  Options: \`--service-id <id>\` (deploy just one service; its connections resolve against already-deployed services), \`--deploy-file <path>\` (default: auto-discover \`hexclave.deploy.ts\` in the current directory; a deploy file is required), \`--cloud-project-id <id>\` (default: the \`HEXCLAVE_PROJECT_ID\` env var), \`--no-build-logs\` (status lines only). It never publishes your project configuration — that is \`hexclave config push\`, a separate command, because several repositories can deploy into one project and each push replaces the whole config.

  GitHub Actions example:

  \`\`\`yaml title=".github/workflows/deploy.yaml"
  - run: npm i -g @hexclave/cli
  - run: hexclave deploy
    env:
      HEXCLAVE_PROJECT_ID: \${{ secrets.HEXCLAVE_PROJECT_ID }}
      HEXCLAVE_SECRET_SERVER_KEY: \${{ secrets.HEXCLAVE_SECRET_SERVER_KEY }}
  \`\`\`

  ## Local development

  \`hexclave dev --config-file hexclave.config.ts --service-id web\` (services come from \`hexclave.deploy.ts\` next to it, or \`--deploy-file <path>\`) runs the service's \`devCommand\` with its env vars injected (plus the development-environment credentials) — services run directly on your machine during development, never in containers. Passing \`-- <command>\` instead (or additionally) overrides the devCommand.

  ## Checking status and debugging failures

  \`deploy\` already waits and reports per-service success/failure and URLs. To inspect later:

  \`\`\`sh title="Terminal"
  npx @hexclave/cli@latest exec --cloud-project-id <project-id> \\
    "const p = await hexclaveServerApp.getProject(); \\
     const svc = (await p.listDeploymentServices()).find(s => s.id === 'web'); \\
     return { status: svc.status, url: svc.url, run: svc.latest_run };"
  \`\`\`

  A service's \`status\` is one of \`not_deployed\`, \`queued\`, \`building\`, \`deployed\`, \`failed\`, or \`canceled\`; a run's is \`queued\`, \`building\`, \`ready\`, \`error\`, or \`canceled\`.

  A failed run's \`error\` field is only a one-line summary. Do not guess the cause from it — fetch the actual build output by run id (printed by \`deploy\`; or \`listDeploymentRuns('web', { limit: 5 })\`):

  \`\`\`sh title="Terminal"
  npx @hexclave/cli@latest exec --cloud-project-id <project-id> \\
    "const p = await hexclaveServerApp.getProject(); \\
     return p.getDeploymentRunLogs('<run-id>');"
  \`\`\`

  ## Domains

  Public services already have a platform URL; a verified custom domain becomes their preferred user-facing URL. A custom domain is also how a private HTTP service can expose a public URL. A service with no HTTP port rejects domains. Internal HTTP traffic uses \`service("<id>").url(<port>)\`; internal TCP traffic uses \`.hostname()\` plus a literal port. Prefer the CLI to attach an HTTP domain:

  \`\`\`sh title="Terminal"
  npx @hexclave/cli@latest exec --cloud-project-id <project-id> \\
    "const p = await hexclaveServerApp.getProject(); \\
     await p.addDeploymentServiceDomain('api', 'app.example.com'); \\
     return p.getDeploymentServiceDomain('api', 'app.example.com');"
  \`\`\`

  The returned \`dns_records\` are what the user must create at their DNS provider; poll \`getDeploymentServiceDomain\` to see verification flip. A hostname can only be attached to one service across all of Hexclave. Humans can also add domains in the dashboard (service → Domains). Agents should not do that in a browser.

  ## Removing a service

  Removing a service from \`deployment.services\` stops it from being deployed, but does not (yet) tear down its existing deployment — automatic cleanup of removed services is planned.
`;
