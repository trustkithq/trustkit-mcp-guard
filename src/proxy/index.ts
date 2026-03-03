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
import { type Persistence, initPersistence } from "../persistence/index.js";
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
	let persistence: Persistence | null = null;
	let cleanupInterval: ReturnType<typeof setInterval> | undefined;

	async function start(): Promise<void> {
		// 0. Initialize persistence (SQLite)
		persistence = initPersistence(config.audit, logger);
		if (persistence) {
			audit.addSink(persistence.createSink());
			// Run cleanup every hour
			cleanupInterval = setInterval(() => persistence?.cleanup(), 60 * 60 * 1000);
			cleanupInterval.unref();
		}

		// 1. Connect to all upstream MCP servers
		upstreams = await connectAllUpstreams(config.servers, logger);

		// 2. Build routing table from discovered tools
		router.buildRoutes(upstreams);

		// 2a. Register discovered tools in persistence
		if (persistence) {
			for (const upstream of upstreams) {
				persistence.toolRegistry.registerTools(upstream.name, upstream.tools);
			}
		}

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
		const startTime = performance.now();
		const toolName = params.name;

		// Look up the route
		const route = router.resolve(toolName);
		if (!route) {
			audit.log({
				tool: toolName,
				allowed: false,
				reason: "Unknown tool",
				requestId,
				durationMs: Math.round(performance.now() - startTime),
			});
			throw new McpError(ErrorCode.InvalidParams, `Unknown tool: "${toolName}"`, {
				tool: toolName,
			});
		}

		// Evaluate policy
		const decision = policy.evaluate(toolName);

		// Reject if policy denies — audit and throw
		if (!decision.allowed) {
			audit.log({
				tool: toolName,
				allowed: false,
				reason: decision.reason,
				requestId,
				serverName: route.upstream.name,
				durationMs: Math.round(performance.now() - startTime),
			});
			throw new McpError(ErrorCode.InvalidRequest, `Tool call denied: ${decision.reason}`, {
				tool: toolName,
				reason: decision.reason,
			});
		}

		// Check upstream health before forwarding
		if (route.upstream.status === "down") {
			const msg = `Upstream "${route.upstream.name}" is unavailable`;
			audit.log({
				tool: toolName,
				allowed: true,
				reason: decision.reason,
				requestId,
				serverName: route.upstream.name,
				durationMs: Math.round(performance.now() - startTime),
				error: msg,
			});
			throw new McpError(ErrorCode.InternalError, msg, {
				tool: toolName,
				upstream: route.upstream.name,
			});
		}

		// Forward to upstream, then audit with duration
		try {
			const result = await route.upstream.client.callTool({
				name: toolName,
				arguments: params.arguments,
			});
			audit.log({
				tool: toolName,
				allowed: true,
				reason: decision.reason,
				requestId,
				serverName: route.upstream.name,
				durationMs: Math.round(performance.now() - startTime),
			});
			return result as {
				content: Array<{ type: "text"; text: string }>;
				isError?: boolean;
			};
		} catch (error: unknown) {
			const err = toError(error);
			// Mark upstream as down on connection-level failures
			markUpstreamDown(route.upstream, err.message);
			audit.log({
				tool: toolName,
				allowed: true,
				reason: decision.reason,
				requestId,
				serverName: route.upstream.name,
				durationMs: Math.round(performance.now() - startTime),
				error: err.message,
			});
			throw new McpError(ErrorCode.InternalError, `Upstream call failed: ${err.message}`, {
				tool: toolName,
				upstream: route.upstream.name,
			});
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
			if (persistence) {
				persistence.toolRegistry.registerTools(upstream.name, upstream.tools);
			}
			log.info({ upstream: upstream.name, toolCount: router.size }, "Routing table refreshed");
		} catch (error: unknown) {
			log.error(
				{ upstream: upstream.name, error: toError(error).message },
				"Failed to refresh tools from upstream",
			);
		}
	}

	function markUpstreamDown(upstream: UpstreamConnection, reason: string): void {
		if (upstream.status === "down") return;
		upstream.status = "down";
		log.warn({ upstream: upstream.name, reason }, "Upstream marked as down");
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

		// Race cleanup against a 5-second timeout
		const SHUTDOWN_TIMEOUT_MS = 5000;
		const cleanup = async (): Promise<void> => {
			if (cleanupInterval) {
				clearInterval(cleanupInterval);
			}
			if (server) {
				await server.close();
			}
			await closeAllUpstreams(upstreams, logger);
			if (persistence) {
				persistence.cleanup();
				persistence.close();
			}
		};

		const timeout = new Promise<void>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("Shutdown timed out")), SHUTDOWN_TIMEOUT_MS);
			timer.unref();
		});

		try {
			await Promise.race([cleanup(), timeout]);
			log.info({}, "MCP Guard proxy stopped");
		} catch (error: unknown) {
			log.warn({ error: toError(error).message }, "Shutdown timed out, forcing exit");
		}
	}

	return { start, close };
}
