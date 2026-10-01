# syntax=docker/dockerfile:1.7
# Multi-stage build for the API, the release (migrate) job and the web client.
#   docker compose build            (see docker-compose.yml)
#   docker build --target api .     (API only)

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# ---- build: install the workspace once, build the API bundle and the web app
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# The bill reader (tesseract.js) needs only the compact English model; the full one (11 MB) is dropped.
# The web app's source maps go to the API (for the error log), never to the public site.
RUN pnpm --filter @digitalbahi/api build \
 && pnpm --filter @digitalbahi/web build \
 && mkdir -p /out/web-sourcemaps && find apps/web/dist -name "*.map" -exec mv {} /out/web-sourcemaps/ \; \
 && pnpm --filter @digitalbahi/api deploy --legacy --prod /out/api \
 && cp -r packages/db/migrations /out/api/migrations \
 && rm -rf /out/api/assets && cp -r apps/api/assets /out/api/assets \
 && find /out/api/node_modules -path "*@tesseract.js-data/eng/4.0.0" -type d -prune -exec rm -rf {} +

# ---- api: bundled server + production node_modules only
FROM node:22-slim AS api
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/package.json ./package.json
COPY --from=build --chown=node:node /out/api/dist ./dist
COPY --from=build --chown=node:node /out/api/migrations ./migrations
# Fonts for PDF reports (English, Hindi and the rupee sign).
COPY --from=build --chown=node:node /out/api/assets ./assets
COPY --from=build --chown=node:node /out/web-sourcemaps ./web-sourcemaps
# Error log files (errors-YYYY-MM-DD.log): mount a volume here to keep them.
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ---- migrate: same image, runs the release step then exits
FROM api AS migrate
CMD ["node", "--enable-source-maps", "dist/deploy.js"]

# ---- web: static PWA behind Caddy (TLS, compression, /api reverse proxy)
FROM caddy:2 AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
