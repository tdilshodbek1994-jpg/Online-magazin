# syntax=docker/dockerfile:1.7
# Optional corporate/sandbox proxy CA can be supplied as a build secret: --secret id=ca,src=<ca.pem>
FROM node:22.23-bookworm-slim AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
RUN --mount=type=secret,id=ca,required=false sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; npm install -g pnpm@10.28.0'
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=ca,required=false sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; pnpm install --frozen-lockfile --filter @om/web...'
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm --filter @om/shared build && pnpm --filter @om/web build

FROM node:22.23-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
