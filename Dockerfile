# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY data/*.json ./data/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ARG GIT_COMMIT=
ENV GIT_COMMIT=${GIT_COMMIT}
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DSLD_STORE_PATH=/data/dsld.sqlite
WORKDIR /app
# Label store volume; created here so a fresh named volume is owned by the node user.
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]
