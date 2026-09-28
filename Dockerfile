# Unprivileged nginx: runs as uid 101 and listens on 8080, so the container
# needs no capabilities and works with a read-only root filesystem.
FROM nginxinc/nginx-unprivileged:stable-alpine

ENV NGINX_ENTRYPOINT_QUIET_LOGS=1

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
