# Penny engine for container hosts (Atlasflow etc.). Listens on $PORT (3000 here), GET / and /healthz return 200.
FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages ./packages
COPY apps/engine ./apps/engine
COPY apps/web ./apps/web
COPY souls ./souls
RUN bun install --frozen-lockfile || bun install
RUN cd apps/web && bun run build
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER bun
CMD ["bun", "apps/engine/src/main.ts"]
