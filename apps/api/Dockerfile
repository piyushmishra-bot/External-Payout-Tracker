# Build from the repo root: docker build -f apps/api/Dockerfile -t eh-api .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root --omit=dev --ignore-scripts && npm i -g tsx@4
COPY packages/core packages/core
COPY apps/api apps/api
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
EXPOSE 4010
CMD ["tsx", "src/server.ts"]
