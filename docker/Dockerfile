# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV npm_config_update_notifier=false

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

# `ws` and node:sqlite are dependency-free at runtime; tsc emits plain ESM.
RUN npx tsc -b packages/protocol packages/mux packages/shared apps/edge apps/agent

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/edge/dist/main.js", "--host", "0.0.0.0", "--port", "8787", "--data-dir", "/data"]