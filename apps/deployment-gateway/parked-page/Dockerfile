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

# Runs as root, deliberately. This image has to listen on whatever port the
# service it replaces declared, and a service may legitimately declare 80 — a
# privileged port a non-root process cannot bind, which fails as
# `listen EACCES` and crash-loops the machine. (Docker hides this locally by
# setting net.ipv4.ip_unprivileged_port_start=0; Fly does not, so it only shows
# up on a real machine.) The alternative, `setcap cap_net_bind_service` on the
# node binary, keeps the non-root user but depends on file capabilities
# surviving the registry and the runtime — more to go wrong than it is worth for
# a process that serves one constant string, writes nothing, and reads nothing
# from a request but its Accept header.
CMD ["node", "server.mjs"]
