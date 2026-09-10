# Deployment gateway

One Fly app proxies every `<suffix>.deploy.built-with-hexclave.com` request to
`https://hxc-<suffix>.fly.dev`. Marshal uses the existing Fly app identity to generate
these hostnames. Nginx handles HTTP, streaming uploads/downloads, and WebSockets.
There is no per-deployment routing table or ownership lookup.

Source and deployment configuration live here. Hosted components remain on Vercel
under `<project-id>.built-with-hexclave.com`; they are not in this traffic path.
DNS can stay on Vercel. The gateway has one wildcard certificate, rather than requesting
a certificate for each deployment. Fly app certificates for customer-supplied domains
continue to be managed separately by Marshal.

This directory also holds [parked-page](parked-page/README.md), the page a STOPPED
deployment serves. It is a separate image with its own lifecycle: the gateway is one Fly app
this repository deploys, while the parked page is published to Docker Hub and pulled by
tenant apps whose services Marshal has parked. They live together because both are platform
infrastructure sitting in front of customer deployments, and neither is a tenant's own code.

## Initial setup

Run once for the shared gateway, before deploying the Marshal hostname change.
Choose an available app name and your Fly organization. These commands provision real
infrastructure; they are not part of the local test.

```sh
cd apps/deployment-gateway
export HEXCLAVE_GATEWAY_APP=hexclave-deployment-gateway
fly apps create "$HEXCLAVE_GATEWAY_APP" --org YOUR_FLY_ORG
fly ips allocate-v6 --app "$HEXCLAVE_GATEWAY_APP"
fly ips allocate-v4 --shared --app "$HEXCLAVE_GATEWAY_APP"
fly deploy --app "$HEXCLAVE_GATEWAY_APP" --ha=true
fly scale count 2 --app "$HEXCLAVE_GATEWAY_APP"
fly certs add '*.deploy.built-with-hexclave.com' --app "$HEXCLAVE_GATEWAY_APP"
fly certs setup '*.deploy.built-with-hexclave.com' --app "$HEXCLAVE_GATEWAY_APP"
```

In Vercel DNS for `built-with-hexclave.com`:

1. Add `*.deploy` A and AAAA records pointing to the gateway's allocated IPv4/IPv6.
   Use the addresses reported by `fly ips list --app "$HEXCLAVE_GATEWAY_APP"`.
2. Add the DNS validation records **exactly as reported by `fly certs setup`**.
   Wildcard issuance uses DNS-01. Keep the validation records for automated renewal.
3. Keep the existing `*` record for hosted components pointing at Vercel. Do not
   move the root domain, root wildcard, or hosted-components certificate validation.
4. Verify with `fly certs check '*.deploy.built-with-hexclave.com' --app "$HEXCLAVE_GATEWAY_APP"`.
   Wait for a valid certificate before releasing the new Marshal URLs.

The gateway's default `.fly.dev` hostname intentionally returns 421: only deployment
hostnames route traffic. Health checks use `Host: gateway-health.internal` and `/healthz`,
so no customer URL path is reserved by the gateway.

For a separate preproduction gateway, create another Fly app from the same source and
use a separate wildcard domain. Set `HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN` to the bare
suffix (for example, `deploy.example.net`) on the gateway with `fly deploy --env
HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=deploy.example.net`. Configure wildcard DNS and its
certificate using that suffix. The value must be a lowercase DNS domain, without `*.`.

Pass the same environment variable to the local Marshal live-test command and optionally
the Docker test command. Both use the production domain when the variable is unset.
The override does not change Fly app names. The backend's production namespace reservation
is unchanged; this override supports testing the gateway and Marshal directly.

## Updates and operations

Deploy from this directory with `fly deploy --app "$HEXCLAVE_GATEWAY_APP"`. Source changes
are independent of Marshal and hosted-components releases. CI can run this same command
using a Fly deploy token scoped to the gateway app; keep that token in CI secrets.

The checked-in configuration keeps two machines running in the primary region and disables
autostop. It balances by connections because WebSockets can remain active for a long time.
Adjust machine count/size and concurrency from measured traffic. Two machines provide
machine redundancy, not regional failover. Health checks verify the gateway process, not
all downstream applications.

Upstream connections use HTTPS, SNI, and certificate verification. The HTTP Host must be
the target `.fly.dev` name so Fly can route it; the public hostname is forwarded in
`X-Forwarded-Host`. Apps generating absolute URLs should use their configured public URL
or correctly trust forwarded headers. Cookie domains and Location headers are preserved;
the gateway does not rewrite application authentication policy.

Response buffering, request buffering, and caching are disabled. The upstream read/write
idle timeout is one hour; WebSocket clients should send heartbeats and reconnect after
network interruptions or gateway deployments. This is an idle timeout, not a guarantee
that a connection survives machine replacement. Access logs omit query strings and cookies.

`HEXCLAVE_GATEWAY_RESOLVER` defaults to Fly's internal DNS resolver. The local integration
test overrides it with Docker DNS; this does not change the host-to-app mapping.

Useful commands:

```sh
fly checks list --app "$HEXCLAVE_GATEWAY_APP"
fly logs --app "$HEXCLAVE_GATEWAY_APP"
fly status --app "$HEXCLAVE_GATEWAY_APP"
```

## Tests

With Docker, Bun, and OpenSSL already installed, from the repository root:

```sh
bun test apps/deployment-gateway/gateway.test.mjs
```

This builds the actual gateway image and runs a pinned Bun fixture on an isolated Docker
network. A generated test-only TLS certificate is trusted only inside that disposable
container. Tests verify host rejection, health routing, path/method forwarding, cookies,
TLS hostname validation, incremental SSE/chunked responses, and authenticated WebSocket
text/binary echo with clean close. Additional checks cover concurrent applications,
redirects and upstream errors, streaming uploads, disconnected clients, unavailable
upstreams, gateway restart/reconnection, and invalid domain configuration. Containers, network, generated image tag and test keys
are removed afterward. Docker may retain downloaded base images and build cache.

The test port defaults to `10070 + 100 * NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX` (18170 by default).
Override it with `HEXCLAVE_GATEWAY_TEST_PORT` if occupied. The normal Vitest suite skips
this opt-in container test, and runs `parked-page`'s ordinary unit tests instead — the
vitest config here includes that directory by name rather than opting the whole app out:

```sh
pnpm test run apps/deployment-gateway
```

Once the gateway and wildcard DNS/TLS are ready:

```sh
pnpm -C apps/marshal test:platform-domains:live
```

This uses real Fly/S3 credentials in `apps/marshal/.env.local`, creates a disposable
application, and checks both its direct Fly URL and gateway URL. Open the two printed
`/compatibility` pages and click **Run browser checks** on each. It waits for both reports
before asserting the combined result, then redeploys and checks its stable URL. Cleanup
removes only the disposable application/state, never the shared gateway, DNS or wildcard
certificate. No Vercel alias or bypass secret is needed.

For browser cookie isolation, run two live tests in separate terminals. Before running
both compatibility checks, open the first app's `/compatibility/cookie-isolation` page
and click **Set test session**. Click **Read session** to see that app's marker. On the second app's isolation page,
**Read session** should return only null values.
Set a session on the second app and verify each still returns its own marker. Then run
the normal compatibility checks on both direct and gateway URLs so both runners can
verify redeploy and clean up. This checks host-only/current-host cookie isolation;
applications must still avoid setting cookies on a shared parent domain.

Before rollout, run this live check against the gateway and confirm every category passes.
