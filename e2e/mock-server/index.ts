#!/usr/bin/env node

/**
 * Mock MCP server for e2e testing.
 *
 * Usage: tsx e2e/mock-server/index.ts [--config <path>]
 *
 * Config is a JSON file with:
 *   { "tools": [{ "name": "read_file", "response": { "content": [{ "type": "text", "text": "hello" }] } }] }
 *
 * If no config is given, registers a default set of tools.
 * Records all tools/call invocations to stderr as JSON lines.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface MockToolConfig {
	name: string;
	description?: string;
	response?: { content: Array<{ type: string; text: string }>; isError?: boolean };
	error?: string;
}

interface MockConfig {
	tools: MockToolConfig[];
}

const DEFAULT_CONFIG: MockConfig = {
	tools: [
		{
			name: "read_file",
			description: "Read a file",
			response: { content: [{ type: "text", text: "file contents here" }] },
		},
		{
			name: "write_file",
			description: "Write a file",
			response: { content: [{ type: "text", text: "ok" }] },
		},
		{
			name: "search_files",
			description: "Search for files",
			response: { content: [{ type: "text", text: "found 3 results" }] },
		},
	],
};

function loadConfig(): MockConfig {
	const { values } = parseArgs({
		options: { config: { type: "string", short: "c" } },
		strict: false,
	});

	if (values.config) {
		const raw = readFileSync(values.config as string, "utf-8");
		return JSON.parse(raw) as MockConfig;
	}
	return DEFAULT_CONFIG;
}

function record(event: Record<string, unknown>): void {
	process.stderr.write(`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
}

async function main(): Promise<void> {
	const config = loadConfig();
	const server = new Server(
		{ name: "mock-mcp-server", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	const toolMap = new Map<string, MockToolConfig>();
	for (const tool of config.tools) {
		toolMap.set(tool.name, tool);
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return {
			tools: config.tools.map((t) => ({
				name: t.name,
				description: t.description ?? `Mock tool: ${t.name}`,
				inputSchema: { type: "object" as const },
			})),
		};
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		record({ event: "tools/call", tool: name, args });

		const tool = toolMap.get(name);
		if (!tool) {
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
		}

		if (tool.error) {
			throw new Error(tool.error);
		}

		return tool.response ?? { content: [{ type: "text", text: "ok" }] };
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	record({ event: "server_started", tools: config.tools.map((t) => t.name) });
}

main().catch((error) => {
	process.stderr.write(`Mock server error: ${error}\n`);
	process.exit(1);
});
