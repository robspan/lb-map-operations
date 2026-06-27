FROM node:22-alpine AS build

WORKDIR /workspace
COPY package.json package-lock.json nx.json tsconfig.base.json jest.config.ts jest.preset.js ./
COPY apps ./apps
COPY eslint.config.mjs .prettierrc .prettierignore ./
RUN npm ci
RUN npx nx run-many -t build -p ops-contract,ops-ui,ops-api
RUN npx nx run ops-api:prune
RUN mkdir -p dist/apps/ops-api/public \
  && cp -R dist/apps/ops-ui/browser/. dist/apps/ops-api/public/

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV OPS_METRICS_PORT=9090
ENV OPS_UI_PUBLIC_DIR=/app/public

WORKDIR /app
COPY --from=build /workspace/dist/apps/ops-api/package.json /workspace/dist/apps/ops-api/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /workspace/dist/apps/ops-api ./

EXPOSE 3000 9090
USER node
CMD ["node", "main.js"]
