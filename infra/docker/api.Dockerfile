# syntax=docker/dockerfile:1.7
# Optional corporate/sandbox proxy CA can be supplied as a build secret: --secret id=ca,src=<ca.pem>
FROM node:22.23-bookworm-slim AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
RUN --mount=type=secret,id=ca,required=false sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; npm install -g pnpm@10.28.0'
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=secret,id=ca,required=false sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; pnpm install --frozen-lockfile --filter @om/api...'
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @om/shared build && pnpm --filter @om/api build && pnpm deploy --filter @om/api --prod --legacy /out

# syntax-free runtime stage
FROM node:22.23-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/migrations ./migrations
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
