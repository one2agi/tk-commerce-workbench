# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/corepack
RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS dev
COPY --chown=node:node . .
USER node
ENV NODE_ENV=development

FROM dev AS builder
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @tk/web build
RUN pnpm --filter @tk/worker deploy --prod /out/worker

FROM node:22-bookworm-slim AS web-runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM node:22-bookworm-slim AS worker-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=builder /out/worker ./
USER node
CMD ["node", "--import", "tsx", "src/cli.ts"]
