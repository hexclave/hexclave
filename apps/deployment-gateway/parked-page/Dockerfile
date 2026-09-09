# The image a parked deployment runs. Published to Docker Hub and referenced by
# digest from Marshal (HEXCLAVE_DEPLOYMENT_PARKED_IMAGE) — see README.md.
#
# Public on purpose: tenant Fly apps pull it with no registry credentials, and
# Fly's own registry repositories are app-scoped, so an image in one app's
# repository is not reliably pullable from another app's machines.
FROM node:24-alpine

WORKDIR /app
COPY server.mjs ./

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
