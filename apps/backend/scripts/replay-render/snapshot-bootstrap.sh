#!/bin/sh
# Runs as root inside a fresh freestyle/ubuntu-sm VM and installs everything the
# replay renderer needs (see bootstrap-replay-render-snapshot.ts). Render VMs
# booted from the resulting snapshot only ever receive data (params.json), never
# code.
#
# Keep the puppeteer/rrweb pins in sync with docker/dependencies/replay-render-mock.
set -eux
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils unzip ffmpeg \
  fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk fonts-dejavu-core \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  libdrm2 libxshmfence1 libx11-xcb1 libdbus-1-3
apt-get clean
rm -rf /var/lib/apt/lists/*

NODE_VERSION=22.20.0
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
echo "${NODE_ARCHIVE_SHA256:?NODE_ARCHIVE_SHA256 must be set}  /tmp/node.tar.xz" | sha256sum -c -
mkdir -p /opt/node
tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
rm /tmp/node.tar.xz
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx

# puppeteer rather than puppeteer-core so the chrome-headless-shell it downloads
# is the exact build its CDP client was released against.
mkdir -p /opt/replay-render
cd /opt/replay-render
cat > package.json <<'EOF'
{ "private": true, "type": "module", "dependencies": { "puppeteer": "25.12.0", "rrweb": "1.1.3" } }
EOF
export PUPPETEER_CACHE_DIR=/opt/puppeteer-cache
PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund --omit=dev
npx puppeteer browsers install chrome-headless-shell
ln -sf "$(find /opt/puppeteer-cache -type f -name chrome-headless-shell | head -1)" /usr/local/bin/chrome-headless-shell
mv /tmp/render.mjs /opt/replay-render/render.mjs
chmod -R a+rX /opt/replay-render /opt/puppeteer-cache /opt/node

# The renderer runs as this user; it owns nothing but its own job directory.
useradd --system --create-home --shell /usr/sbin/nologin renderer
mkdir -p /jobs
chmod 711 /jobs

chrome-headless-shell --version
ffmpeg -version | head -1
node --version
