# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/admin/Dockerfile .
FROM node:26.12.1-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.14.0
ARG VITE_API_URL=https://api.libes6.ru
ENV VITE_API_URL=${VITE_API_URL}
COPY . .
RUN pnpm install --filter @gustaf/admin --frozen-lockfile --ignore-scripts
RUN pnpm --filter @gustaf/admin test && pnpm --filter @gustaf/admin build
# The CSP may only connect to the API's origin; derive it once from the same URL the bundle uses.
RUN API_ORIGIN="$(node -e 'console.log(new URL(process.env.VITE_API_URL).origin)')" \
  && mkdir -p /out/snippets \
  && sed "s|__API_ORIGIN__|${API_ORIGIN}|g" apps/admin/nginx/security-headers.conf > /out/snippets/security-headers.conf \
  && ! grep -q __API_ORIGIN__ /out/snippets/security-headers.conf

FROM nginx:1.31-alpine AS runtime
COPY apps/admin/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out/snippets/ /etc/nginx/snippets/
COPY --from=build /workspace/apps/admin/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
