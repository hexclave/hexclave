# @hexclave/growth-agent

The Eve agent app powering the Growth app: it receives run dispatches from the Hexclave backend, analyzes customer project data, and writes findings, reports, briefs, and action items back through the backend's `internal/growth-agent` API.

Built on the [eve](https://eve.dev) agent framework.

## Requirements

- Node.js 24.x (eve requires `node >= 24`).
- Vercel Sandbox credentials for local development when `HEXCLAVE_GROWTH_SANDBOX_BACKEND=vercel`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `HEXCLAVE_GROWTH_BACKEND_URL` | Base URL of the Hexclave backend. The client appends `/api/latest/internal/growth-agent`. |
| `HEXCLAVE_GROWTH_AGENT_API_SECRET` | Shared service secret. Used both to verify inbound bearer tokens from the backend and as the outbound bearer token to the backend. |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Explicit Vercel Sandbox credentials for local development when the backend is pinned to `vercel`. Vercel deployments normally authenticate automatically through `VERCEL_OIDC_TOKEN` (OIDC must be enabled for the project). |

The website-research subagent installs Chromium and `agent-browser` in its Eve
sandbox template, then reuses one browser process for the full child session.
Individual `browse-page` and screenshot calls do not create additional VMs.

## Environment files

The development script uses `dotenv-cli` like the other monorepo apps: it loads the documented variables from `.env`, then the prefix-aware local defaults from `.env.development`. Put machine-local overrides in `.env.local`.

## Development

```sh
pnpm dev  # eve dev on port ${NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81}49 (default 8149)
```

## HTTP surface

Custom channel routes are mounted by eve at the authored path verbatim (no `/eve/v1/<channel>` prefix). All routes require `Authorization: Bearer $HEXCLAVE_GROWTH_AGENT_API_SECRET`.

- `POST /runs/analysis-phase` — ack `{ accepted: true }`, run in background
- `POST /runs/daily-brief` — ack `{ accepted: true }`, run in background
- `POST /interview` — 501 (Phase 7)
- `POST /chat` — 501 (Phase 9)

eve's own framework routes (session API, health) remain available under `/eve/v1/*`, e.g. `GET /eve/v1/health`.
