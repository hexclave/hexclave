FROM node:24-slim

# secure-exec publishes a Linux glibc sidecar, but no musl build. Keep this on
# Debian-based node:24-slim rather than switching the mock to an Alpine image.
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY guest-package.json guest-package-lock.json /app/guest-node-modules/
RUN cd /app/guest-node-modules \
  && mv guest-package.json package.json \
  && mv guest-package-lock.json package-lock.json \
  && npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
RUN mkdir -p /app/module-cache \
  && groupadd --system freestyle \
  && useradd --system --gid freestyle --home-dir /home/freestyle --create-home freestyle \
  && chown -R freestyle:freestyle /app/module-cache /home/freestyle

ENV NPM_CONFIG_CACHE=/app/module-cache/npm-cache
USER freestyle

EXPOSE 8080

CMD ["node", "server.mjs"]
