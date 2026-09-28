# Node serves the page and the API; SQLite lives on the /data volume. Runs as the
# unprivileged node user on 8080, so the container needs no capabilities and
# works with a read-only root filesystem.
FROM node:24-alpine

ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app

COPY package.json ./
COPY server/ server/
COPY public/ public/

# An empty named volume copies this directory's ownership when first mounted.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
