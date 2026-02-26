#!/usr/bin/env node

/**
 * MCP Guard CLI entry point.
 *
 * Usage: mcp-guard --config guard.yaml
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		config: { type: "string", short: "c", default: "guard.yaml" },
		version: { type: "boolean", short: "v" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.version) {
	console.log("mcp-guard 0.1.0");
	process.exit(0);
}

if (values.help) {
	console.log(`
mcp-guard - AI execution firewall for MCP-based tools

Usage:
  mcp-guard [options]

Options:
  -c, --config <path>  Path to config file (default: guard.yaml)
  -v, --version        Show version
  -h, --help           Show this help
`);
	process.exit(0);
}

console.log(`Loading config from: ${values.config}`);
console.log("MCP Guard proxy is not yet implemented. Coming soon.");
