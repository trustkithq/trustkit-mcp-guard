import { randomUUID } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

interface HttpSession {
	transport: StreamableHTTPServerTransport;
	server: Server;
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
	let httpServer: HttpServer | undefined;
	const sessions = new Map<string, HttpSession>();

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

		// 3. Set up notification forwarding for tools/list_changed
		setupToolListRefresh();

		// 4. Connect agent-facing transport
		if (config.listen.transport === "stdio") {
			server = createMcpServer();
			const transport = new StdioServerTransport();
			await server.connect(transport);
		} else {
			setupHttpServer();
			await startHttpServer();
		}

		log.info(
			{ toolCount: router.size, upstreams: upstreams.map((u) => u.name) },
			"MCP Guard proxy started",
		);
	}

	/** Creates an MCP Server with tools/list and tools/call handlers wired to shared state. */
	function createMcpServer(): Server {
		const s = new Server({ name: "mcp-guard", version: "0.1.0" }, { capabilities: { tools: {} } });

		s.setRequestHandler(ListToolsRequestSchema, async () => {
			return { tools: router.allTools() };
		});

		s.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			return handleToolCall(request.params, extra.requestId);
		});

		return s;
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

	/**
	 * Sets up the HTTP server with per-session transport management.
	 * Each client connection gets its own StreamableHTTPServerTransport + MCP Server pair.
	 */
	function setupHttpServer(): void {
		httpServer = createServer(async (req, res) => {
			const method = req.method ?? "UNKNOWN";
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			const startTime = performance.now();
			const sessionId = req.headers["mcp-session-id"] as string | undefined;

			log.debug({ method, path: url.pathname, sessionId }, "HTTP request received");

			if (url.pathname === "/mcp" || url.pathname === "/sse") {
				const stateless = url.pathname === "/sse";
				try {
					await handleMcpRequest(req, res, method, sessionId, stateless);
					log.debug(
						{
							method,
							path: url.pathname,
							status: res.statusCode,
							durationMs: Math.round(performance.now() - startTime),
						},
						"HTTP request completed",
					);
				} catch (error: unknown) {
					const err = toError(error);
					log.error(
						{
							method,
							path: url.pathname,
							error: err.message,
							durationMs: Math.round(performance.now() - startTime),
						},
						"HTTP request failed",
					);
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "text/plain" }).end("Internal Server Error");
					}
				}
				return;
			}
			if (url.pathname === "/health" && method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			log.debug({ method, path: url.pathname }, "HTTP 404 — unknown path");
			res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
		});
	}

	async function handleMcpRequest(
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
		method: string,
		sessionId: string | undefined,
		stateless: boolean,
	): Promise<void> {
		// Stateless mode (/sse): each POST is self-contained, no session tracking.
		// This avoids SSE GET stream lifecycle issues with clients like OpenWebUI.
		if (stateless) {
			if (method !== "POST") {
				res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
				return;
			}
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			const sessionServer = createMcpServer();
			await sessionServer.connect(transport);
			await transport.handleRequest(req, res);
			return;
		}

		// Stateful mode (/mcp): full session management with GET SSE streams.

		// Existing session — forward to its transport
		if (sessionId) {
			const session = sessions.get(sessionId);
			if (!session) {
				log.warn({ sessionId }, "Request for unknown session");
				res.writeHead(400, { "Content-Type": "text/plain" }).end("Unknown session");
				return;
			}
			await session.transport.handleRequest(req, res);
			if (method === "DELETE") {
				log.debug({ sessionId }, "Session closed by client");
				sessions.delete(sessionId);
				await session.server.close();
			}
			return;
		}

		// New session — only POST can initialize
		if (method !== "POST") {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing session ID");
			return;
		}

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
		});
		const sessionServer = createMcpServer();
		await sessionServer.connect(transport);

		await transport.handleRequest(req, res);

		const newSessionId = transport.sessionId;
		if (newSessionId) {
			sessions.set(newSessionId, { transport, server: sessionServer });
			log.debug({ sessionId: newSessionId }, "New session created");

			transport.onclose = () => {
				log.debug({ sessionId: newSessionId }, "Session transport closed");
				sessions.delete(newSessionId);
			};
		}
	}

	function startHttpServer(): Promise<void> {
		const srv = httpServer;
		if (!srv) {
			return Promise.resolve();
		}
		const { port, host } = config.listen;
		return new Promise((resolve, reject) => {
			srv.once("error", (err: NodeJS.ErrnoException) => {
				reject(
					new NetworkError(`Failed to start HTTP server: ${err.message}`, {
						retryable: false,
						context: { host, port, code: err.code },
						cause: err,
					}),
				);
			});
			srv.listen(port, host, () => {
				log.info(
					{ host, port, endpoint: `http://${host}:${port}/mcp` },
					"HTTP transport listening",
				);
				resolve();
			});
		});
	}

	async function close(): Promise<void> {
		log.info({}, "Shutting down MCP Guard proxy");

		// Race cleanup against a 5-second timeout
		const SHUTDOWN_TIMEOUT_MS = 5000;
		const cleanup = async (): Promise<void> => {
			if (cleanupInterval) {
				clearInterval(cleanupInterval);
			}
			// Close all HTTP sessions
			for (const [id, session] of sessions) {
				log.debug({ sessionId: id }, "Closing session on shutdown");
				await session.server.close();
			}
			sessions.clear();
			if (httpServer) {
				const srv = httpServer;
				await new Promise<void>((resolve, reject) => {
					srv.close((err) => (err ? reject(err) : resolve()));
				});
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
