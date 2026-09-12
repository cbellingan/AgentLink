FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json vitest.config.ts ./
RUN npm ci

COPY . .
RUN npm run build:web && npm run build:server

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web ./web
COPY --from=builder /app/.data/agent-link-state.sample.json ./.data/agent-link-state.sample.json

VOLUME ["/app/.data"]
EXPOSE 3000

CMD ["node", "dist/server.mjs"]
