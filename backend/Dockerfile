FROM node:24.10.0-bookworm-slim AS build
WORKDIR /app

COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig*.json ./
COPY backend/src ./src
RUN npm run build \
  && mkdir -p dist/database/migrations \
  && cp src/database/migrations/*.sql dist/database/migrations/ \
  && npm prune --omit=dev

FROM node:24.10.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000

WORKDIR /app
COPY --chown=node:node --from=build /app/package*.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 4000

CMD ["node", "dist/server.js"]
