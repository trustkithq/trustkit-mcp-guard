#!/usr/bin/env node

/**
 * MCP Guard CLI entry point.
 *
 * Usage: mcp-guard --config guard.yaml
 */

import { parseArgs } from "node:util";
import { loadConfig } from "./config/loader.js";
import { AppError } from "./errors/base.js";
import { createLogger } from "./logger/index.js";
import { createProxy } from "./proxy/index.js";

const { values } = parseArgs({
	options: {
		config: { type: "string", short: "c", default: "guard.yaml" },
		version: { type: "boolean", short: "v" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.version) {
	process.stderr.write("mcp-guard 0.1.0\n");
	process.exit(0);
}

if (values.help) {
	process.stderr.write(`
mcp-guard - AI execution firewall for MCP-based tools

Usage:
  mcp-guard [options]

Options:
  -c, --config <path>  Path to config file (default: guard.yaml)
  -v, --version        Show version
  -h, --help           Show this help
\n`);
	process.exit(0);
}

async function main(): Promise<void> {
	const config = loadConfig(values.config as string);
	const logger = createLogger({ level: config.logLevel });

	logger.info(
		{
			transport: config.listen.transport,
			port: config.listen.transport === "http" ? config.listen.port : undefined,
			servers: config.servers.map((s) => s.name),
			defaultAction: config.policy.defaultAction,
			ruleCount: config.policy.rules.length,
		},
		"Config loaded",
	);

	const proxy = createProxy(config, logger);

	// Prevent multiple shutdown calls
	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info({}, "Shutdown signal received");
		await proxy.close();
		process.exit(0);
	};

	// Graceful shutdown on signals
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Detect client disconnect (stdin EOF) — triggers shutdown for stdio transport
	if (config.listen.transport === "stdio") {
		process.stdin.on("end", () => {
			logger.info({}, "Client disconnected (stdin EOF)");
			shutdown();
		});
	}

	await proxy.start();
}

main().catch((error: unknown) => {
	if (error instanceof AppError) {
		process.stderr.write(`Error: ${error.message}\n`);
		process.exit(1);
	}
	if (error instanceof Error) {
		process.stderr.write(`Unexpected error: ${error.message}\n`);
		process.exit(1);
	}
	process.stderr.write(`Unexpected error: ${String(error)}\n`);
	process.exit(1);
});
