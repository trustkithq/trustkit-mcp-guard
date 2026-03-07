FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN pnpm build

FROM node:22-slim
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist dist/

# Default config + data volume mount points
VOLUME ["/etc/mcp-guard", "/data"]

# Default config path (override with --config)
ENV MCP_GUARD_CONFIG=/etc/mcp-guard/guard.yaml

# HTTP transport default port
EXPOSE 31415

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/etc/mcp-guard/guard.yaml"]
