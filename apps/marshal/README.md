# Marshal

The Google Cloud-backed container runtime behind the Deployments app. Stateless: no database, its
only state is the S3-compatible bucket. All configuration is environment variables — see
[`.env`](./.env), which documents every one of them.

## Entrypoints

| File | Used by |
| --- | --- |
| `src/server.ts` | `pnpm start` / `pnpm dev` / the e2e workflows — owns the listener |
| `src/vercel.ts` | any host that owns its own listener — exports the app, binds nothing |
| `src/index.ts` | Vercel's entrypoint detection — re-exports the built `dist/vercel.mjs` |

`pnpm build` (tsdown) produces both `dist/server.mjs` and `dist/vercel.mjs`. Local development
and CI run the TypeScript directly through tsx and need no build.

## Deploying on Vercel

Project settings:

- **Root directory** `apps/marshal`, with "include source files outside of the root directory"
  enabled (this is a pnpm workspace).
- **Build command** `pnpm run build` — `src/index.ts` imports the artifact it produces.
- **Framework** is declared in [`vercel.json`](./vercel.json) as `elysia`; the function's
  `maxDuration` is declared in `src/index.ts`, where Vercel's builder statically reads it.
- **Deployment Protection must be off** (or carry a bypass) for the production domain. Two
  callers that hold no Vercel credential must reach it: the Hexclave backend on `/v1/*`, and
  the GCP builder VM on `/internal/deployments/:id/complete`.
- Attach a **stable custom domain** and set `MARSHAL_PUBLIC_URL` to its HTTPS origin. Builder VMs call
  back on that URL minutes after the request that started them, so a per-deployment URL would
  break every build the moment a newer deployment replaced it. Plain HTTP is accepted only when
  `MARSHAL_ALLOW_MOCKS=1` for local simulation.

Environment: set everything in `.env` that is marked required, plus `MARSHAL_PUBLIC_URL`.
`MARSHAL_PORT` is ignored — the platform owns the listener. Never set `MARSHAL_ALLOW_MOCKS`
in production; without it the mock builder and existing-project test override both fail closed.

Source uploads never pass through the function: `POST /v1/namespaces/:ns/uploads` returns a
presigned bucket URL that the CLI uploads the tarball to directly.

Domain claims, project-pool entries and its creation ledger, and namespace-to-project assignments are authenticated with
`HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY`, with their object key bound into the MAC. Marshal fails
closed on the older unsigned shape: before rolling this version into an environment that already
has `domains/*.json`, `gcp-project-pool/*.json`, `gcp-project-pool-ledger.json`, or
`tenants/*.json`, migrate or recreate those records from a trusted
snapshot. Automatically trusting and rewriting an unsigned object would authenticate exactly the
forgery this boundary is intended to detect.

## GCP tenancy and lifecycle

Marshal follows Google's [Cloud Run multi-tenant guidance](https://docs.cloud.google.com/run/docs/securing/multi-tenant): every namespace receives a dedicated GCP project. The project is the tenant security, quota, billing-attribution, monitoring, and deletion boundary. Put these projects in a folder reserved for untrusted tenant workloads; do not place first-party control-plane services in that folder.

Per that guidance, Marshal keeps a pool of pre-provisioned projects (`HEXCLAVE_MARSHAL_GCP_PROJECT_POOL_SIZE`, default 0) so the first deploy into a namespace is a bucket claim instead of a fifteen-minute project provisioning. Pool state lives in the bucket: `tenants/<ns>.json` is the namespace → project assignment (the idempotency anchor), `gcp-project-pool/<projectId>.json` holds one pool project's provisioning state, and `gcp-project-pool-ledger.json` is the creation-rate ledger. When the pool is empty or disabled, provisioning falls back to a deterministic per-namespace project created synchronously on first use, so a stalled pool degrades to the pre-pool latency rather than to a failed deploy.

Provisioning is a **cron-driven resumable state machine**, not background work. `creating → billing_pending → apis_pending → iam_pending → ready → claimed` are resume points: the entry is written *before* the Resource Manager create call, every wait is a state in the bucket, and each step is idempotent so it can be re-entered from whatever the bucket last recorded. This is required rather than merely tidy — the hosted deployment is frozen the moment a response is written, so work started in the background of a request does not run, and an unrecorded create would leave a billed project nothing could ever find.

Two authenticated maintenance endpoints drive it, scheduled in `vercel.json` (and by `apps/backend/scripts/run-cron-jobs.ts` locally). They live under `/v1/` and use the ordinary bearer check, which on this prefix also accepts `CRON_SECRET`. Set `CRON_SECRET` on the Vercel project to any independent value; it need not equal `MARSHAL_API_KEY`, and it opens nothing else. It must be **set**, though: with it unset Vercel sends no `Authorization` header and every invocation is rejected, which shows up only as a pool that never fills.

- `GET /v1/maintenance/project-pool/step` (every two minutes) advances every in-flight project concurrently, running each one as far as it can go and yielding only on a genuine Google Cloud wait — billing propagation and API enablement — or on its own ~75-second deadline. It then creates as many projects as the deficit allows, bounded by at most three in flight and ten creations per hour: deleted GCP projects hold organization project quota for thirty days, so an unbounded advancer would exhaust the organization rather than merely spend money.
- `GET /v1/maintenance/project-pool/reap` (hourly) condemns anything stuck in flight for more than forty-five minutes and deletes its project; returns to `ready` a claimed entry whose `tenants/<ns>.json` does not point back at it, once past a fifteen-minute grace that avoids racing a live claim; and deletes a claimed entry whose namespace *does* point at it, since the assignment is then the authority. That last case is what bounds `listPoolProjects()` — a LIST plus a GET per entry, on the deploy path — by pool size instead of by lifetime tenant count.

Both ticks run under one `withReconciliationLease("__platform__", "project-pool")`, because crons are at-least-once and ticks can overlap; a tick that loses the lease reports itself skipped instead of failing.

Service mapping:

- `serverless` → Cloud Run with the requested minimum/maximum instances and Direct VPC egress. Cloud Run has one ingress port, so a serverless spec must declare exactly one HTTP port. Marshal uses Cloud Run's recommended disabled Invoker IAM check instead of an `allUsers` binding, so public and load-balanced services work under domain-restricted-sharing organization policies; private services remain protected by their ingress setting.
- `server` → one `e2-micro` Compute Engine VM. Its persistent disk is grow-only and survives service deletion for later adoption. A public server receives a scale-to-zero Cloud Run nginx gateway; direct Internet ingress to the VM is not permitted by its firewall.
- source build → a short-lived Container-Optimized OS VM running the existing BuildKit harness. It obtains a short-lived Artifact Registry token from the metadata server; Marshal deletes the VM after recording the completion webhook.
- custom domain → Marshal first returns a tenant-bound TXT record at `_hexclave-verification.<hostname>` plus the shared frontend's A record. The user creates both during domain setup; polling the domain endpoint verifies the TXT proof before Marshal claims or routes the hostname. A verified hostname receives a per-domain serverless NEG and `EXTERNAL_MANAGED` backend service in the tenant project, routed through one environment-scoped global external Application Load Balancer in `HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID`. Certificate Manager certificates/map entries, the global IP, URL map, target HTTPS proxy, forwarding rule, and empty fallback backend remain in that platform project. This keeps Cloud Run and its backend security boundary tenant-local while avoiding one fixed-cost frontend per tenant or domain. Marshal serializes URL-map reconciliation with a distributed lease so concurrent tenant updates cannot discard routes.

The platform project and tenant projects must belong to the same organization. Global cross-project backend references do not require Shared VPC, but they do require the controller to have `compute.backendServices.use` on tenant backends. At larger fleet sizes, monitor the URL map's 1 MiB configuration limit and Certificate Manager map-entry quotas and shard tenants across additional environment-scoped frontends before reaching either limit. The shared frontend reduces fixed cost but creates a control-plane blast radius: isolate its project, restrict its administrators, and set the `compute.restrictCrossProjectServices` organization policy on the platform project — it is evaluated against the project holding the URL map, so it bounds which backends that frontend may reference to the tenant folder alone.

Cloud Run has no equivalent of Fly's request-triggered VM suspend/resume for a persistent server. A `server` with `min_instances: 0` therefore remains eligible to run as its single GCE instance; it preserves availability and disk semantics but does not guarantee scale-to-zero billing.

## Local GCP simulator

Development and provider-dependent backend E2E tests use `docker/dependencies/gcp-mock`. It implements only the Google REST resources Marshal owns; tests that do not cross the provider boundary continue to use focused `GcpClient` fakes. Set `HEXCLAVE_MARSHAL_GCP_MOCK_URL=local` to derive the simulator address from `NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX`, or provide an explicit URL. Both forms require `MARSHAL_ALLOW_MOCKS=1`, and the introspection API also requires `HEXCLAVE_MARSHAL_GCP_MOCK_TOKEN` because it exposes resolved container environment values.

The simulator deliberately reproduces provider details Marshal depends on: permission-hidden unknown projects, long-running operations, newly-enabled API propagation errors, Cloud Run create/update body differences and stale reads, revision image digests, Compute Engine operation/resource shapes, grow-only persistent disks, Certificate Manager resources/states, URL-map fingerprint updates, same-organization cross-project backend validation, and Cloud Logging resource labels. The `src/gcp/mock-contract.test.ts` lifecycle is kept parallel to `src/gcp/live.test.ts`; changes to a provider adapter should update both. Deterministic `.verified.test` certificate activation and synthetic container readiness/log output are test controls, not claims that the simulator executes containers or provisions a real network.

## Required IAM

Credentials resolve in three ways, in this order: workload identity federation, an explicit
`GOOGLE_APPLICATION_CREDENTIALS` file, then the GCE metadata server.

Prefer federation for any hosted deployment; it is required on a host with no metadata server
(Vercel). Set `HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE` to the provider resource and
`HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT` to the controller service account it
impersonates — setting only one of the two is a startup error rather than a fallback. Marshal
exchanges the host's OIDC assertion for a federated token and impersonates the service account
with it, so no long-lived key exists anywhere. This matters more here than it usually does: the
controller identity can create, bill, and delete every tenant project, so a static key for it
would be the most valuable secret the system holds.

The assertion is read from the incoming request's `x-vercel-oidc-token` header, falling back to
`VERCEL_OIDC_TOKEN` (or whatever `HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_TOKEN_ENV` names) for
builds and local development. Those are genuinely different places, not redundancy: Vercel
populates the environment variable during builds and in `vercel dev`, but a running Function
receives the assertion as a per-invocation header and has no such variable, so a deployment
that only read the environment would authenticate locally and hold no credential in production.
OIDC federation must also be enabled on the Vercel project itself, or no assertion is issued at
all.

Use `GOOGLE_APPLICATION_CREDENTIALS` only for local administration, and never copy a key into
this repository or a tenant project.

[`scripts/bootstrap-gcp.sh`](./scripts/bootstrap-gcp.sh) provisions the IAM and org-policy
prerequisites below — tenant folder, platform project, controller service account, every role
binding, the org policies Marshal depends on, and the federation pool — and is idempotent. It
does not raise the organization's project-creation quota or touch the Logging default sink;
it prints both as remaining manual steps.

The Marshal controller needs:

- `roles/resourcemanager.projectCreator` and `roles/resourcemanager.projectDeleter` on the configured tenant-project parent.
- `roles/billing.user` on `HEXCLAVE_MARSHAL_GCP_BILLING_ACCOUNT`, **and** `roles/billing.projectManager` on the tenant-project parent. Both are needed: attaching billing to a new tenant project requires a permission on the billing account and another on the project itself, so `billing.user` alone fails the first deploy with a 403.
- `roles/browser` (or another role granting `resourcemanager.projects.get`) on the tenant-project parent, for the project lookups reconciliation performs.
- inherited access on the tenant-project folder equivalent to `roles/serviceusage.serviceUsageAdmin`, `roles/resourcemanager.projectIamAdmin`, `roles/compute.admin`, `roles/run.admin`, `roles/artifactregistry.admin`, `roles/iam.serviceAccountUser`, and `roles/logging.viewer`.
- `roles/compute.loadBalancerServiceUser` (or another role containing `compute.backendServices.use`) on tenant projects whose backends the platform URL map references.
- `roles/compute.loadBalancerAdmin` and `roles/certificatemanager.owner` on the platform project. Certificate Manager's predefined editor role omits resource deletion, so it cannot clean up certificates, map entries, or maps. Enable `compute.googleapis.com` and `certificatemanager.googleapis.com` there before starting Marshal.

The organization or folder Logging defaults must retain Cloud Run and Compute Engine entries in the project's `_Default` log bucket. Disabling that sink makes Marshal's logs API return no entries even when the controller has `roles/logging.viewer`.

Marshal enables Compute Engine, Cloud Run, Artifact Registry, IAM, and Cloud Logging in each tenant project. It grants only these runtime bindings inside the project:

- the default Compute service account: `roles/artifactregistry.writer` and `roles/logging.logWriter`;
- the Cloud Run service agent: `roles/compute.networkUser` for Direct VPC egress.

For a disposable project created out-of-band, `HEXCLAVE_MARSHAL_GCP_EXISTING_PROJECT_ID_FOR_TESTS` bypasses project creation. It is guarded by `MARSHAL_ALLOW_MOCKS=1` and must never point at a production project.

## Disposable live verification

`src/gcp/live.test.ts` is opt-in because it creates billable resources. Set Application Default Credentials plus `HEXCLAVE_MARSHAL_GCP_LIVE_TEST=1`, `HEXCLAVE_MARSHAL_GCP_LIVE_BILLING_ACCOUNT`, and `HEXCLAVE_MARSHAL_GCP_LIVE_PLATFORM_PROJECT_ID`; optionally set `HEXCLAVE_MARSHAL_GCP_LIVE_PROJECT_PARENT=folders/<id>`. The existing platform project must have Compute Engine and Certificate Manager enabled and the controller roles documented above. Then run `pnpm -C apps/marshal test -- src/gcp/live.test.ts`.

The test creates one `hxctest-` tenant project and uses the configured existing platform project for an environment-scoped frontend. Its `try/finally` boundary removes the domain, every shared frontend/certificate resource created for the unique live-test environment, and the tenant project. It covers project/API/IAM provisioning, Artifact Registry, VPC creation, Cloud Run deployment and update, HTTP status and Cloud Logging, a persistent Compute Engine server and disk adoption across update, cross-project custom-domain load-balancer creation/status/removal, individual runtime deletion, and final cleanup. The custom hostname intentionally remains unconfigured, so the test verifies the returned DNS record and pending certificate state without changing public DNS.
