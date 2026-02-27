# TrustKit MCP Guard

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Docker](#docker)
- [Configuration](#configuration)
- [License](#license)

AI execution firewall for MCP-based tools.

MCP Guard is a proxy that sits between AI clients and MCP servers, enforcing security policies on tool calls. It validates, controls, and audits every tool execution.

## Features

- **Policy engine** — allowlist/denylist rules with glob patterns
- **Default deny** — block everything not explicitly allowed
- **Audit logging** — structured JSON events for every decision
- **Read-only mode** — restrict tools to read operations only

## Quick Start

```bash
pnpm install
pnpm build
node dist/cli.js --config examples/basic-config.yaml
```

## Docker

```bash
docker build -t mcp-guard .
docker run mcp-guard --config /path/to/config.yaml
```

## Configuration

See [`examples/basic-config.yaml`](examples/basic-config.yaml) for a complete example.

## License

This project is licensed under [Apache 2.0](LICENSE).
