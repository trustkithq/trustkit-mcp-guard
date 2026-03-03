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

try {
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

	// TODO: initialize proxy with config
	logger.info({}, "MCP Guard proxy is not yet implemented. Coming soon.");
} catch (error: unknown) {
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
}
