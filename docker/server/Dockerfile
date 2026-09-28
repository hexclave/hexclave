ARG NODE_VERSION=24.19.0

# Base
FROM node:${NODE_VERSION} AS base

WORKDIR /app

RUN apt-get update && \
    apt-get upgrade -y && \
    rm -rf /var/lib/apt/lists

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PNPM_HOME/bin:$PATH

RUN corepack enable
RUN corepack prepare pnpm@11.5.0 --activate
# Pinned: unpinned global installs mean an upstream release can change image builds without a commit
# here (turbo 2.10.11 changed prune's gitignore handling and broke this build).
RUN pnpm add -g turbo@2.10.11
RUN pnpm add -g tsx@4.23.12


# Prune stage
FROM base AS pruner

COPY . .

RUN tsx ./scripts/generate-sdks.ts

# https://turbo.build/repo/docs/guides/tools/docker
# The SDK packages generated above (packages/js, packages/next, ...) are gitignored, so prune must not
# honor .gitignore or their sources would be missing from out/full and the build below would fail.
RUN turbo prune --scope=@hexclave/backend --scope=@hexclave/dashboard --scope=@hexclave/template --docker --use-gitignore=false



# Build stage
FROM base AS builder

# Skip generate-sdks.ts in preinstall hook (file not available in pruned output)
ENV HEXCLAVE_SKIP_TEMPLATE_GENERATION=true

# copy over package.json files and install dependencies
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml .
COPY .gitignore .
COPY pnpm-workspace.yaml .
COPY turbo.json .
COPY configs ./configs
COPY --from=pruner /app/scripts/postinstall-patch-next-async-debug-info.mjs ./scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# copy over the rest of the code for the build
COPY --from=pruner /app/out/full/ .

# Dashboard still needs standalone output for its Next.js build
ENV NEXT_CONFIG_OUTPUT=standalone

# Build the backend and dashboard
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm turbo run docker-build --filter=@hexclave/backend... --filter=@hexclave/dashboard...

# Build the self-host seed script
RUN --mount=type=cache,id=pnpm,target=/pnpm/store cd apps/backend && pnpm build-self-host-migration-script



# Final image
FROM node:${NODE_VERSION}-slim

WORKDIR /app

# Install packages needed for deployment
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y openssl postgresql-client socat && \
    rm -rf /var/lib/apt/lists

# Copy built dashboard (standalone includes monorepo apps/ structure)
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public

# Restore workspace node_modules needed by non-Next runtime scripts (e.g. migrations)
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages

# Copy the bundled Elysia backend LAST — the dashboard standalone output includes
# a traced subset of apps/backend/ via pnpm workspace symlinks, and Docker COPY
# creates opaque directory layers that hide files from earlier layers. By copying
# the real backend dist after everything else, its files are guaranteed visible.
COPY --from=builder --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder --chown=node:node /app/apps/backend/prisma ./apps/backend/prisma
COPY --from=builder --chown=node:node /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=builder --chown=node:node /app/apps/backend/package.json ./apps/backend/package.json

# Add the entrypoint script
COPY ./docker/server/entrypoint.sh .
RUN chmod +x entrypoint.sh

# Hash the complete assembled runtime tree once while building the image. The
# entrypoint uses this manifest to invalidate persistent runtime copies when any
# bundled backend, dashboard, workspace, or entrypoint artifact changes. Include
# entry types, modes, symlink targets, and regular-file contents, but not mtimes.
RUN { \
      find /app -mindepth 1 ! -path /app/.stack-runtime-build-identity -printf 'entry\t%y\t%m\t%p\t%l\n'; \
      find /app -mindepth 1 ! -path /app/.stack-runtime-build-identity -type f -exec sha256sum {} +; \
    } | LC_ALL=C sort | sha256sum | cut -d ' ' -f1 > /tmp/stack-runtime-build-identity && \
    mv /tmp/stack-runtime-build-identity /app/.stack-runtime-build-identity

WORKDIR /app

# Define environment variables for both services
ENV NODE_ENV=production
ENV BACKEND_PORT=8102
ENV DASHBOARD_PORT=8101

USER node

# The entrypoint completes migrations and seeding before either service listens. Give large
# production databases a realistic startup window, then require backend database readiness
# rather than accepting a process that cannot serve authenticated traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 \
  CMD ["node", "-e", "Promise.all([fetch('http://127.0.0.1:' + process.env.BACKEND_PORT + '/health?db=1'), fetch('http://127.0.0.1:' + process.env.DASHBOARD_PORT + '/')]).then((responses) => { if (responses.some((response) => !response.ok)) process.exit(1); }).catch(() => process.exit(1));"]

# Set entrypoint to run both backend and dashboard
ENTRYPOINT ["./entrypoint.sh"]
