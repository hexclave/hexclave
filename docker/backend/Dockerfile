# Backend for Cloud Run / self-hosted deployment (fallback backend server).
# Connects to the same AWS services (RDS, S3, KMS) as the Vercel deployment.
#
# Build:  docker build -f docker/backend/Dockerfile -t stack-backend .
# Run:    docker run -p 8102:8102 --env-file .env stack-backend

ARG NODE_VERSION=24.19.0

# Base
FROM node:${NODE_VERSION} AS base

WORKDIR /app

RUN apt-get update && \
    apt-get upgrade -y && \
    rm -rf /var/lib/apt/lists/*

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

# Only prune backend (no dashboard). The SDK packages generated above are gitignored, so prune must
# not honor .gitignore or their sources would be missing from out/full.
RUN turbo prune --scope=@hexclave/backend --scope=@hexclave/template --docker --use-gitignore=false


# Build stage
FROM base AS builder

# Skip generate-sdks.ts in preinstall hook (file not available in pruned output)
ENV HEXCLAVE_SKIP_TEMPLATE_GENERATION=true

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml .
COPY .gitignore .
COPY pnpm-workspace.yaml .
COPY turbo.json .
COPY configs ./configs
COPY --from=pruner /app/scripts/postinstall-patch-next-async-debug-info.mjs ./scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .

# Build backend only
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm turbo run docker-build --filter=@hexclave/backend...


# Final image
FROM node:${NODE_VERSION}-slim

WORKDIR /app

RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Copy the bundled Elysia server plus the pruned workspace/runtime deps that
# tsdown externalizes for native packages, Prisma, OpenTelemetry, and SDK calls.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/apps/backend ./apps/backend
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/configs ./configs

# Prisma schema (needed at runtime by Prisma client)
COPY --from=builder --chown=node:node /app/apps/backend/prisma ./apps/backend/prisma

ENV NODE_ENV=production
ENV PORT=8102
ENV HOSTNAME=0.0.0.0

USER node

EXPOSE 8102

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health?db=1').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "apps/backend/dist/server.mjs"]
