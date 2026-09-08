FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

# Substitute only our resolver setting; preserve nginx's request-time variables.
ENV NGINX_ENVSUBST_FILTER=^HEXCLAVE_GATEWAY_ \
    HEXCLAVE_GATEWAY_RESOLVER=[fdaa::3]
COPY nginx.conf /etc/nginx/nginx.conf
COPY gateway.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
