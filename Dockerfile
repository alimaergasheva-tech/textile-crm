# Сборка: docker compose -f docker-compose.prod.yml build   (цели api и static)
FROM node:22-slim AS deps
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/miniapp/package.json apps/miniapp/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# ---- API: миграции при каждом старте, затем сервер ----
FROM source AS api
ENV NODE_ENV=production FILES_DIR=/data/files PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @textile/api db:migrate && { [ -z \"$PLATFORM_ADMIN_EMAIL\" ] || [ -z \"$PLATFORM_ADMIN_PASSWORD\" ] || pnpm --filter @textile/api db:seed-platform; } && pnpm --filter @textile/api start"]

# ---- Сайт и Mini App: статика + Caddy (HTTPS сам) ----
FROM source AS build
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @textile/web build && pnpm --filter @textile/miniapp build

FROM caddy:2 AS static
COPY --from=build /app/apps/web/dist /srv/web
COPY --from=build /app/apps/miniapp/dist /srv/mini
COPY deploy/Caddyfile /etc/caddy/Caddyfile
