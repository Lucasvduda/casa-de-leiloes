# syntax=docker/dockerfile:1.7

# ---------- build: instala tudo e compila ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
RUN npm ci
COPY tsconfig.base.json ./
COPY api/ api/
RUN npm run build --workspace api

# ---------- runtime: so o necessario, sem root ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
RUN npm ci --omit=dev --workspace api --include-workspace-root=false \
  && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY api/migrations api/migrations

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/main.js"]
