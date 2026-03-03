import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AuditLogger } from "../audit/logger.js";
import type { GuardConfig } from "../config/schema.js";
import { NetworkError, toError } from "../errors/base.js";
import type { Logger } from "../logger/index.js";
import { PolicyEngine } from "../policy/engine.js";
import { ToolRouter } from "./router.js";
import { type UpstreamConnection, closeAllUpstreams, connectAllUpstreams } from "./upstream.js";

export interface McpGuardProxy {
	/** Start the proxy: connect upstreams, build routes, listen for client. */
	start(): Promise<void>;
	/** Shut down the proxy gracefully. */
	close(): Promise<void>;
}

/**
 * Creates the MCP Guard proxy.
 * The proxy acts as a full MCP server to the AI client and a full MCP client
 * to each upstream server, enforcing policy on every tools/call.
 */
export function createProxy(config: GuardConfig, logger: Logger): McpGuardProxy {
	const log = logger.child({ component: "proxy" });
	const policy = new PolicyEngine(config.policy);
	const audit = new AuditLogger(logger);
	const router = new ToolRouter(logger);

	let upstreams: UpstreamConnection[] = [];
	let server: Server | undefined;

	async function start(): Promise<void> {
		// 1. Connect to all upstream MCP servers
		upstreams = await connectAllUpstreams(config.servers, logger);

		// 2. Build routing table from discovered tools
		router.buildRoutes(upstreams);

		// 3. Create agent-facing MCP server
		server = new Server({ name: "mcp-guard", version: "0.1.0" }, { capabilities: { tools: {} } });

		// 4. Register tools/list handler — returns aggregated tool list
		server.setRequestHandler(ListToolsRequestSchema, async () => {
			return { tools: router.allTools() };
		});

		// 5. Register tools/call handler — policy → audit → forward or reject
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			return handleToolCall(request.params, extra.requestId);
		});

		// 6. Set up notification forwarding for tools/list_changed
		setupToolListRefresh();

		// 7. Connect agent-facing transport
		const transport = createAgentTransport();
		await server.connect(transport);

		log.info(
			{ toolCount: router.size, upstreams: upstreams.map((u) => u.name) },
			"MCP Guard proxy started",
		);
	}

	async function handleToolCall(
		params: { name: string; arguments?: Record<string, unknown> },
		requestId: string | number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
		const toolName = params.name;

		// Look up the route
		const route = router.resolve(toolName);
		if (!route) {
			audit.log({
				tool: toolName,
				allowed: false,
				reason: "Unknown tool",
				requestId,
			});
			throw new McpError(ErrorCode.InvalidParams, `Unknown tool: "${toolName}"`, {
				tool: toolName,
			});
		}

		// Evaluate policy
		const decision = policy.evaluate(toolName);

		// Audit the decision (regardless of outcome)
		audit.log({
			tool: toolName,
			allowed: decision.allowed,
			reason: decision.reason,
			requestId,
			upstreamName: route.upstream.name,
		});

		// Reject if policy denies
		if (!decision.allowed) {
			throw new McpError(ErrorCode.InvalidRequest, `Tool call denied: ${decision.reason}`, {
				tool: toolName,
				reason: decision.reason,
			});
		}

		// Forward to upstream
		try {
			const result = await route.upstream.client.callTool({
				name: toolName,
				arguments: params.arguments,
			});
			return result as {
				content: Array<{ type: "text"; text: string }>;
				isError?: boolean;
			};
		} catch (error: unknown) {
			const err = toError(error);
			log.error(
				{ tool: toolName, upstream: route.upstream.name, error: err.message },
				"Upstream tool call failed",
			);
			throw new NetworkError(
				`Upstream "${route.upstream.name}" failed for tool "${toolName}": ${err.message}`,
				{
					retryable: true,
					context: { tool: toolName, upstream: route.upstream.name },
					cause: error,
				},
			);
		}
	}

	function setupToolListRefresh(): void {
		for (const upstream of upstreams) {
			upstream.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				log.info({ upstream: upstream.name }, "Upstream tools changed, refreshing");
				await refreshToolsForUpstream(upstream);
			});
		}
	}

	async function refreshToolsForUpstream(upstream: UpstreamConnection): Promise<void> {
		try {
			const result = await upstream.client.listTools();
			upstream.tools = result.tools as Tool[];
			router.buildRoutes(upstreams);
			log.info({ upstream: upstream.name, toolCount: router.size }, "Routing table refreshed");
		} catch (error: unknown) {
			log.error(
				{ upstream: upstream.name, error: toError(error).message },
				"Failed to refresh tools from upstream",
			);
		}
	}

	function createAgentTransport(): StdioServerTransport {
		if (config.listen.transport !== "stdio") {
			// HTTP transport support deferred to Phase 2
			throw new NetworkError(
				`Unsupported listen transport: "${config.listen.transport}". Only "stdio" is supported in this version.`,
				{ retryable: false, context: { transport: config.listen.transport } },
			);
		}
		return new StdioServerTransport();
	}

	async function close(): Promise<void> {
		log.info({}, "Shutting down MCP Guard proxy");
		if (server) {
			await server.close();
		}
		await closeAllUpstreams(upstreams, logger);
		log.info({}, "MCP Guard proxy stopped");
	}

	return { start, close };
}
