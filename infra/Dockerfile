FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2

ENV NODE_ENV=production
WORKDIR /app

RUN npm install --global pnpm@11.17.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/identity/package.json packages/identity/package.json
COPY packages/operations/package.json packages/operations/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/platform/package.json packages/platform/package.json
RUN pnpm install --frozen-lockfile --prod=false

COPY apps/runtime apps/runtime
COPY packages/application packages/application
COPY packages/domain packages/domain
COPY packages/identity packages/identity
COPY packages/operations packages/operations
COPY packages/persistence packages/persistence
COPY packages/platform packages/platform
RUN pnpm --filter @vidha/runtime build

USER node
CMD ["node", "apps/runtime/dist/main.mjs"]
