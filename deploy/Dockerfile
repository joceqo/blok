FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS frontend-deps
WORKDIR /build
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/patches .yarn/patches
COPY packages/angular/package.json packages/angular/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/presets/package.json packages/presets/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/vue/package.json packages/vue/package.json
RUN npm install --global corepack@0.35.0 && corepack enable && yarn install --immutable

FROM frontend-deps AS web-build
COPY desktop/package.json desktop/package-lock.json desktop/.npmrc desktop/
RUN npm ci --prefix desktop
COPY . .
ARG VITE_REACT_GRAB=false
ARG VITE_BLOK_DESKTOP_DOWNLOAD_URL
RUN VITE_REACT_GRAB=$VITE_REACT_GRAB npm run build --prefix desktop

FROM nginx:stable-alpine AS web
COPY --from=web-build /build/desktop/dist /srv
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf


FROM frontend-deps AS room-build
COPY packages/server/node/package*.json packages/server/node/
RUN npm ci --prefix packages/server/node
COPY . .
RUN node scripts/build-node-server.mjs && node scripts/build-hosted-mcp.mjs

FROM node:26-bookworm-slim AS room
RUN apt-get update && apt-get install --no-install-recommends -y python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /room
COPY packages/server/node/package*.json ./
RUN npm ci --omit=dev
COPY packages/server/node/bin bin
COPY --from=room-build /build/packages/server/node/dist dist
USER 65532:65532
ENTRYPOINT ["node", "bin/blok-journal-room.mjs"]


FROM node:26-bookworm-slim AS shell-build
WORKDIR /app
COPY apps/service-node/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/service-node/tsconfig.json ./
COPY apps/service-node/src src
RUN ./node_modules/.bin/tsc && npm prune --omit=dev

FROM room AS service
USER root
WORKDIR /app
COPY --from=shell-build /app/package.json /app/package.json
COPY --from=shell-build /app/node_modules /app/node_modules
COPY --from=shell-build /app/dist /app/dist
COPY --from=room-build /build/apps/service-node/dist/shell/mcp-runtime.mjs /app/dist/shell/mcp-runtime.mjs
COPY --from=room-build /build/apps/service-node/dist/shell/markdown-runtime.mjs /app/dist/shell/markdown-runtime.mjs
COPY apps/service/schema.sql /app/schema.sql
RUN mkdir -p /data && chown 65532:65532 /data \
 && chmod +x /app/dist/shell/blokctl.js && ln -s /app/dist/shell/blokctl.js /usr/local/bin/blokctl
ENV BLOK_SCHEMA_PATH=/app/schema.sql
USER 65532:65532
ENTRYPOINT ["node"]
CMD ["/app/dist/shell/main.js"]
