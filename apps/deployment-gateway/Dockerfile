FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

# Substitute only our gateway settings; preserve nginx's request-time variables.
ENV NGINX_ENVSUBST_FILTER=^HEXCLAVE_GATEWAY_ \
    HEXCLAVE_GATEWAY_RESOLVER=[fdaa::3] \
    HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=deploy.built-with-hexclave.com
COPY 15-platform-domain.envsh /docker-entrypoint.d/15-platform-domain.envsh
RUN chmod +x /docker-entrypoint.d/15-platform-domain.envsh
COPY nginx.conf /etc/nginx/nginx.conf
COPY gateway.js /etc/nginx/njs/gateway.js
COPY gateway.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
