# syntax=docker/dockerfile:1.7

FROM --platform=linux/amd64 node:24-bookworm-slim AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci

FROM backend-deps AS backend-build
COPY backend ./
RUN npm run build
RUN npm prune --omit=dev

FROM --platform=linux/amd64 node:24-bookworm-slim AS client-deps
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci

FROM client-deps AS client-build
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
COPY client ./
RUN npm run build
RUN npm prune --omit=dev

FROM --platform=linux/amd64 node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV BACKEND_PORT=4000
ENV BACKEND_INTERNAL_URL=http://localhost:4000

WORKDIR /app

COPY --chown=node:node --from=backend-build /app/backend/package*.json ./backend/
COPY --chown=node:node --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node --from=backend-build /app/backend/dist ./backend/dist

COPY --chown=node:node --from=client-build /app/client/package*.json ./client/
COPY --chown=node:node --from=client-build /app/client/node_modules ./client/node_modules
COPY --chown=node:node --from=client-build /app/client/.next ./client/.next
COPY --chown=node:node --from=client-build /app/client/public ./client/public
COPY --chown=node:node --from=client-build /app/client/next.config.ts ./client/next.config.ts

COPY --chown=node:node docker/start-fullstack.mjs ./docker/start-fullstack.mjs

USER node
EXPOSE 8080

CMD ["node", "docker/start-fullstack.mjs"]
