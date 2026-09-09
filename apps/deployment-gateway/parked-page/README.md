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

The image is public on Docker Hub so tenant Fly apps can pull it without
credentials. Fly's own registry repositories are app-scoped, so an image pushed
to one app's repository is not reliably pullable from another app's machines.

```sh
cd apps/deployment-gateway/parked-page
docker buildx build --platform linux/amd64 -t hexclave/deployment-parked-page:1 --push .
docker buildx imagetools inspect hexclave/deployment-parked-page:1
```

Take the digest from that last command and set it on Marshal, pinned:

```sh
fly secrets set HEXCLAVE_DEPLOYMENT_PARKED_IMAGE=hexclave/deployment-parked-page@sha256:<digest> --app <marshal-app>
```

Pin the digest rather than the tag. Marshal hands this reference to Fly as the
image a parked machine runs, and a tag that moved under a fleet of already-parked
services would roll every one of them the next time it reconciled.

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
