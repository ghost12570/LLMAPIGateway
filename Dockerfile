FROM node:24-alpine

RUN apk add --no-cache tini
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
