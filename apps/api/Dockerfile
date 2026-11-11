# syntax=docker/dockerfile:1
FROM node:26.12.1-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.14.0
COPY . .
RUN pnpm install --filter @gustaf/api --frozen-lockfile --ignore-scripts
RUN pnpm --filter @gustaf/api build && pnpm --filter @gustaf/api test
RUN pnpm --filter @gustaf/api deploy --legacy --prod --ignore-scripts --config.allowUnusedPatches=true /runtime

FROM node:26.12.1-bookworm-slim AS runtime
RUN apt-get update && apt-get install --yes --no-install-recommends curl ca-certificates && apt-get clean
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
