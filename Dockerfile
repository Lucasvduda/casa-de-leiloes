# syntax=docker/dockerfile:1.7

# ---------- build: instala tudo e compila API + front ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY api/ api/
COPY web/ web/
# O front le estas variaveis NA COMPILACAO (Vite as embute no JavaScript). Devem bater com o servidor:
# a senha das contas de demonstracao e publica de proposito (dinheiro ficticio).
ARG VITE_SHOW_DEMO_HINT=true
ARG VITE_DEMO_PASSWORD=
ENV VITE_SHOW_DEMO_HINT=$VITE_SHOW_DEMO_HINT \
    VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD
RUN npm run build --workspace api && npm run build --workspace web

# ---------- runtime: so o necessario, sem root ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace api --include-workspace-root=false \
  && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY api/migrations api/migrations
COPY --from=build /app/web/dist web/dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/main.js"]
