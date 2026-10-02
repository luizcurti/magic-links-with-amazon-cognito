# Production frontend: nginx with security headers and /api proxied to API Gateway.
# Build from the repository root: docker build -f apps/frontend/Dockerfile .

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --workspace apps/frontend --include-workspace-root=false --ignore-scripts
COPY apps/frontend apps/frontend
RUN npx --workspace apps/frontend vite build

FROM nginxinc/nginx-unprivileged:1.29-alpine
# API base URL, e.g. http://localstack:4566/restapis/<id>/local/_user_request_
ENV API_PROXY_TARGET=http://127.0.0.1:4566
COPY apps/frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
