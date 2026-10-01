FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY node-service/package.json node-service/package-lock.json ./
RUN npm ci --omit=dev
COPY node-service/ ./
COPY --from=web-build /web/dist ./public

RUN mkdir -p /data/uploads /data/generated \
    && chown -R node:node /app /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail "http://127.0.0.1:${PORT}/health" || exit 1

# Railway volumes are mounted as root. Fix ownership before dropping privileges.
CMD ["sh", "-c", "mkdir -p \"${DATA_DIR}/uploads\" \"${DATA_DIR}/generated\" && chown node:node \"${DATA_DIR}\" \"${DATA_DIR}/uploads\" \"${DATA_DIR}/generated\" && exec gosu node node server.js"]
