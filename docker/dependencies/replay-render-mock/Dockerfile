FROM node:22-bookworm-slim

# Debian's Chromium instead of the chrome-headless-shell the real Freestyle
# snapshot uses: Chrome for Testing has no linux-arm64 build, and this mock has
# to run natively on Apple Silicon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium ffmpeg ca-certificates \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
RUN useradd --system --create-home renderer

# Chrome's sandbox needs user namespaces, which Docker's default seccomp
# profile blocks. The container is the isolation boundary here; real renders
# in Freestyle VMs keep Chrome's sandbox on.
ENV CHROME_PATH=/usr/bin/chromium \
  RENDER_NO_SANDBOX=1 \
  HOME=/home/renderer
USER renderer

EXPOSE 8080
# The renderer itself (render.mjs) is mounted from apps/backend/scripts/replay-render
# by docker.compose.yaml, so edits apply without rebuilding the image.
CMD ["node", "server.mjs"]
