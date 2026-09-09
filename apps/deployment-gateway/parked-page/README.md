# Deployment parked page

The page a stopped deployment serves.

When a project on the Free plan reaches the 24-hour limit, the backend's sweeper
asks Marshal to *park* each of its services (see `parkService` in
`apps/marshal/src/services.ts`). Parking rolls the service's machines onto this
image and leaves everything else about the service alone: same Fly app, same
ports, same public IPs, same certificates, same disks, same stored spec. So this
page answers on the deployment's platform hostname and on every custom domain
attached to it, and unparking is a roll back onto the tenant's own image.

The machine keeps `min_instances: 0`, so it sleeps when idle and Fly Proxy starts
it on the next request. A parked service therefore costs nothing to keep parked.

## What it serves

Every path and every method answers **503** with `Cache-Control: no-store`,
`X-Robots-Tag: noindex` and `X-Hexclave-Deployment-Stopped: <reason>`. HTML goes
to clients that asked for HTML, JSON to clients that asked for JSON, and plain
text to everything else (a wildcard `Accept` is a person at a terminal, not a
browser).

503 rather than 402 or 404 because a custom domain pointed at a parked service
would otherwise be deindexed: 503 is the status search engines treat as
temporary. `Retry-After` is deliberately omitted — a parked deployment comes back
when someone acts, not on a timer.

## Configuration

`PORT` — the service's standard-ports holder, which is what Fly maps 80/443 onto.
Marshal sets it at park time; it is the only per-service value this image takes.

`HEXCLAVE_PARKED_REASON` — which copy to render. `free_plan_24h` today; an
unrecognised value renders a generic page rather than an empty one, so an image
older than a newly added reason still works.

There is deliberately nothing else. The dashboard link is a constant that goes
through the project selector rather than naming a project id, which keeps one
published image serving every parked service in the fleet and keeps the project
id off a page the public can see.

## Publishing

Published as `docker.io/bgodil/deployment-parked-page`. It must stay PUBLIC: tenant Fly
machines pull it with no registry credentials, and a private repository would fail every
park. (Fly's own registry is not an option — its repositories are app-scoped, so an image
pushed to one app's repository is not reliably pullable from another app's machines.)

After any push, confirm an unauthenticated puller can still reach it:

```sh
curl -s "https://hub.docker.com/v2/repositories/bgodil/deployment-parked-page/" | grep -o '"is_private":[a-z]*'
```

```sh
cd apps/deployment-gateway/parked-page
docker buildx build --platform linux/amd64 -t bgodil/deployment-parked-page:2 --push .
docker buildx imagetools inspect bgodil/deployment-parked-page:2
```

Take the digest from that last command and set it on Marshal, which deploys on Vercel
(see [apps/marshal/README.md](../../marshal/README.md)):

```sh
vercel env add HEXCLAVE_DEPLOYMENT_PARKED_IMAGE production
# paste: bgodil/deployment-parked-page@sha256:<digest>
```

The digest currently published as `:2` is
`sha256:0ce015355b8f411367c6db5741fca6efe1e9c7475480f41a73642aeeae06d702`.

`:1` is superseded and must not be used: it ran as a non-root user and could not bind a
privileged port, so any service declaring port 80 crash-looped instead of showing the page.

A Vercel environment variable only reaches the running function on the next deployment, so
redeploy Marshal after setting it. Until then Marshal falls back to the tag in
DEFAULT_PARKED_IMAGE.

Pin the digest rather than the tag. Marshal hands this reference to Fly as the
image a parked machine runs, and a tag that moved under a fleet of already-parked
services would roll every one of them the next time it reconciled.

For the same reason, treat a published tag as immutable once anything is parked against
it: publish changes under the next tag and move the pinned digest deliberately, rather than
pushing over one already in use.

## Tests

`server.test.mjs` runs in the normal workspace suite (the gateway's vitest config
includes this directory by name; its own Docker integration test stays opt-in):

```sh
pnpm test run apps/deployment-gateway
```

To look at the page:

```sh
PORT=8080 node apps/deployment-gateway/parked-page/server.mjs
```
