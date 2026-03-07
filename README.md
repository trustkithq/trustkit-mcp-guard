# TrustKit MCP Guard

[![CI](https://github.com/trustkithq/trustkit-mcp-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/trustkithq/trustkit-mcp-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@trustkit/mcp-guard)](https://www.npmjs.com/package/@trustkit/mcp-guard)
[![Docker](https://img.shields.io/badge/ghcr.io-trustkithq%2Fmcp--guard-blue)](https://ghcr.io/trustkithq/mcp-guard)
[![License](https://img.shields.io/github/license/trustkithq/trustkit-mcp-guard)](LICENSE)

## Table of Contents

- [Features](#features)
- [Running](#running)
  - [From npm ](#from-npm)
  - [Docker (production)](#docker-production)
  - [From source (development)](#from-source-development)
- [Client Configuration](#client-configuration)
  - [HTTP mode](#http-mode)
  - [Stdio mode](#stdio-mode)
- [Configuration](#configuration)
- [License](#license)

AI execution firewall for MCP-based tools.

MCP Guard is a proxy that sits between AI clients and MCP servers, enforcing security policies on tool calls. It validates, controls, and audits every tool execution.

## Features

- **Policy engine** — allowlist/denylist rules with glob patterns
- **Default deny** — block everything not explicitly allowed
- **Audit logging** — structured JSON events for every decision
- **Read-only mode** — restrict tools to read operations only

## Running

### From npm

No build step required. Run directly with `npx`:

```bash
npx @trustkit/mcp-guard --config guard.yaml
```

Or install globally:

```bash
npm install -g @trustkit/mcp-guard
mcp-guard --config guard.yaml
```

### Docker (production)

Use the pre-built image from GitHub Container Registry:

```bash
docker run --rm -p 31415:31415 \
  -v ./guard-config:/etc/mcp-guard:ro \
  -v ./guard-data:/data \
  -v ./my-project:/data/project:ro \
  ghcr.io/trustkithq/mcp-guard:latest \
  --config /etc/mcp-guard/guard.yaml
```

Or use the production compose file:

```bash
docker compose -f docker-compose.prod.yaml up
```

The compose file mounts three volumes:

| Volume | Container path | Purpose |
|---|---|---|
| `./guard-config/` | `/etc/mcp-guard/` | Guard configuration (read-only) |
| `./guard-data/` | `/data/` | Audit database and persistent state |
| `./my-project/` | `/data/project/` | Your project files (read-only) |

Edit `docker-compose.prod.yaml` to adjust paths for your setup.

### From source (development)

```bash
git clone https://github.com/trustkithq/trustkit-mcp-guard.git
cd trustkit-mcp-guard
pnpm install
pnpm build
node dist/cli.js --config examples/basic-config.yaml
```

A development compose file is included for building from source:

```bash
docker compose build
docker compose up mcp-guard-http    # HTTP mode
docker compose run --rm mcp-guard   # stdio mode
```

## Client Configuration

### HTTP mode

The guard listens on a port (default `31415`) and AI clients connect via URL. Use this when you want a long-running guard process, persistent audit data, or read-only project access.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mcp-guard": {
      "type": "url",
      "url": "http://localhost:31415/mcp"
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-guard": {
      "url": "http://localhost:31415/mcp"
    }
  }
}
```

**Codex**:

```bash
codex --mcp-server-uri http://localhost:31415/mcp
```

### Stdio mode

The AI client spawns the guard as a child process. No port to manage, no Docker required.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mcp-guard": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@trustkit/mcp-guard", "--config", "guard.yaml"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-guard": {
      "command": "npx",
      "args": ["-y", "@trustkit/mcp-guard", "--config", "guard.yaml"]
    }
  }
}
```

**Codex**:

```bash
codex --mcp-server "npx -y @trustkit/mcp-guard --config guard.yaml"
```

## Configuration

See [`examples/basic-config.yaml`](examples/basic-config.yaml) for a complete example with stdio transport, and [`examples/http-config.yaml`](examples/http-config.yaml) for HTTP transport.

## License

This project is licensed under [Apache 2.0](LICENSE).