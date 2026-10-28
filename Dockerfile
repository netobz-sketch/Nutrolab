FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8090
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chown=node:node seed ./seed
COPY --chown=node:node skill ./skill
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8090
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]
