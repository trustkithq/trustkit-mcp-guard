import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config/schema.js";
import { NetworkError, toError } from "../errors/base.js";
import type { Logger } from "../logger/index.js";

export interface UpstreamConnection {
	/** Server name from config. */
	name: string;
	/** MCP SDK Client instance. */
	client: Client;
	/** Tools discovered from this upstream. */
	tools: Tool[];
	/** Connection status. */
	status: "up" | "degraded" | "down";
}

/**
 * Creates a Client and transport for an upstream server config entry.
 * Does NOT connect — call `client.connect(transport)` separately.
 */
function createClientAndTransport(config: ServerConfig): {
	client: Client;
	transport: StdioClientTransport | StreamableHTTPClientTransport;
} {
	const client = new Client({ name: `mcp-guard->${config.name}`, version: "0.1.0" });

	if (config.transport === "stdio") {
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: config.env,
			cwd: config.cwd,
			stderr: "pipe",
		});
		return { client, transport };
	}

	const transport = new StreamableHTTPClientTransport(new URL(config.url));
	return { client, transport };
}

/**
 * Connects to a single upstream MCP server, discovers its tools.
 * Returns an UpstreamConnection or throws NetworkError.
 */
export async function connectUpstream(
	config: ServerConfig,
	logger: Logger,
): Promise<UpstreamConnection> {
	const log = logger.child({ upstream: config.name });
	const { client, transport } = createClientAndTransport(config);

	try {
		log.info({ transport: config.transport }, "Connecting to upstream");
		await client.connect(transport);
		log.info({}, "Connected to upstream");
	} catch (error: unknown) {
		throw new NetworkError(`Failed to connect to upstream "${config.name}"`, {
			retryable: true,
			context: { upstream: config.name, transport: config.transport },
			cause: error,
		});
	}

	let tools: Tool[];
	try {
		const result = await client.listTools();
		tools = result.tools;
		log.info({ toolCount: tools.length }, "Discovered tools");
	} catch (error: unknown) {
		throw new NetworkError(`Failed to discover tools from upstream "${config.name}"`, {
			retryable: true,
			context: { upstream: config.name },
			cause: error,
		});
	}

	return { name: config.name, client, tools, status: "up" };
}

/**
 * Connects to all upstream servers. Tolerates partial failures
 * (returns connections that succeeded). Throws if all fail.
 */
export async function connectAllUpstreams(
	configs: ServerConfig[],
	logger: Logger,
): Promise<UpstreamConnection[]> {
	const connections: UpstreamConnection[] = [];
	const failures: Array<{ name: string; error: Error }> = [];

	for (const config of configs) {
		try {
			const conn = await connectUpstream(config, logger);
			connections.push(conn);
		} catch (error: unknown) {
			const err = toError(error);
			logger.warn(
				{ upstream: config.name, error: err.message },
				"Failed to connect to upstream — continuing in degraded mode",
			);
			failures.push({ name: config.name, error: err });
		}
	}

	if (connections.length === 0) {
		const names = failures.map((f) => f.name).join(", ");
		throw new NetworkError(`All upstream servers failed to connect: ${names}`, {
			retryable: false,
			context: { failedUpstreams: failures.map((f) => f.name) },
		});
	}

	if (failures.length > 0) {
		logger.warn(
			{
				connected: connections.map((c) => c.name),
				failed: failures.map((f) => f.name),
			},
			"Running in degraded mode — some upstreams unavailable",
		);
	}

	return connections;
}

/**
 * Closes all upstream connections gracefully.
 */
export async function closeAllUpstreams(
	connections: UpstreamConnection[],
	logger: Logger,
): Promise<void> {
	for (const conn of connections) {
		try {
			await conn.client.close();
			logger.debug({ upstream: conn.name }, "Upstream connection closed");
		} catch (error: unknown) {
			logger.warn(
				{ upstream: conn.name, error: toError(error).message },
				"Error closing upstream connection",
			);
		}
	}
}
