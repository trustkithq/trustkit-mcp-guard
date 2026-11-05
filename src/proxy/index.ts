import { randomUUID } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
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
import {
	type UpstreamConnection,
	closeAllUpstreams,
	connectAllUpstreams,
	connectUpstream,
} from "./upstream.js";

export interface McpGuardProxy {
	/** Start the proxy: connect upstreams, build routes, listen for client. */
	start(): Promise<void>;
	/** Shut down the proxy gracefully. */
	close(): Promise<void>;
}

interface HttpSession {
	transport: StreamableHTTPServerTransport;
	server: Server;
	/** performance.now() of the last request seen on this session. */
	lastActivity: number;
	/** POSTs still being answered; a session is never evicted mid tool call. */
	inFlight: number;
}

/** How often idle stateful sessions are swept (at most; shorter if the idle timeout is). */
const SESSION_SWEEP_INTERVAL_MS = 60_000;

interface SseSession {
	transport: SSEServerTransport;
	server: Server;
}

/** Path for the legacy SSE event stream (GET). Per old MCP spec. */
const LEGACY_SSE_PATH = "/sse-legacy";
/** Path for legacy SSE client→server messages (POST). Per old MCP spec. */
const LEGACY_MESSAGES_PATH = "/messages";

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
	let sessionSweepInterval: ReturnType<typeof setInterval> | undefined;
	let httpServer: HttpServer | undefined;
	/** Set on shutdown so reconnect loops and onclose handlers stand down. */
	let shuttingDown = false;
	/** Upstream names with an in-flight reconnect loop (dedupes onclose storms). */
	const reconnecting = new Set<string>();
	/** Pending reconnect timers, keyed by upstream name, cleared on shutdown. */
	const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const sessions = new Map<string, HttpSession>();
	/**
	 * Active legacy SSE sessions, keyed by sessionId from SSEServerTransport.
	 * Used to route POST /messages requests to the correct event stream.
	 */
	const sseSessions = new Map<string, SseSession>();

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

		// 3. Wire lifecycle handlers (tool-list refresh + disconnect/reconnect)
		for (const upstream of upstreams) {
			wireUpstream(upstream);
		}

		// 4. Connect agent-facing transport
		if (config.listen.transport === "stdio") {
			server = createMcpServer();
			const transport = new StdioServerTransport();
			await server.connect(transport);
		} else {
			setupHttpServer();
			await startHttpServer();
			sessionSweepInterval = setInterval(
				sweepIdleSessions,
				Math.min(SESSION_SWEEP_INTERVAL_MS, config.listen.sessionIdleTimeoutMs),
			);
			sessionSweepInterval.unref();
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

		// Forward to upstream, then audit with duration. The per-request timeout
		// comes from the upstream's config so long-running tools (e.g. heavy
		// analytical queries) aren't cut off by the SDK's 60s default.
		const callOptions: RequestOptions = {
			timeout: route.upstream.config.requestTimeoutMs,
			resetTimeoutOnProgress: route.upstream.config.resetTimeoutOnProgress,
		};
		if (route.upstream.config.maxTotalTimeoutMs !== undefined) {
			callOptions.maxTotalTimeout = route.upstream.config.maxTotalTimeoutMs;
		}
		try {
			const result = await route.upstream.client.callTool(
				{ name: toolName, arguments: params.arguments },
				undefined,
				callOptions,
			);
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
			// A failed or timed-out call does NOT take the upstream down: the
			// connection is very likely still healthy and only this one request
			// was slow or errored. Genuine transport death is detected by the
			// client's `onclose` hook (see wireUpstream), which marks the
			// upstream down and starts reconnection. This prevents a single slow
			// query from latching the whole upstream off until a restart.
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

	/**
	 * Wires lifecycle handlers on an upstream's client:
	 *   - tools/list_changed → rebuild the routing table
	 *   - onclose           → transport died; mark down and start reconnecting
	 *   - onerror           → log transport errors
	 *
	 * Re-invoked after every successful reconnect because the client is replaced.
	 */
	function wireUpstream(upstream: UpstreamConnection): void {
		upstream.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			log.info({ upstream: upstream.name }, "Upstream tools changed, refreshing");
			await refreshToolsForUpstream(upstream);
		});
		upstream.client.onclose = () => {
			if (shuttingDown) return;
			markUpstreamDown(upstream, "Upstream transport closed");
			startReconnect(upstream);
		};
		upstream.client.onerror = (error: Error) => {
			log.warn({ upstream: upstream.name, error: error.message }, "Upstream transport error");
		};
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
	 * Starts the reconnect loop for a downed upstream. Idempotent per upstream:
	 * repeated calls (e.g. an onclose storm) while a loop is already running are
	 * ignored.
	 */
	function startReconnect(upstream: UpstreamConnection): void {
		if (shuttingDown || reconnecting.has(upstream.name)) return;
		if (!config.reconnect.enabled) {
			log.warn(
				{ upstream: upstream.name },
				"Auto-reconnect disabled — upstream stays down until restart",
			);
			return;
		}
		reconnecting.add(upstream.name);
		attemptReconnect(upstream, 0);
	}

	/**
	 * Schedules one backoff reconnect attempt. On success the upstream's client
	 * is swapped in place (keeping the same UpstreamConnection reference so
	 * routes stay valid) and marked up. On failure it retries with exponential
	 * backoff until it succeeds or the proxy shuts down.
	 */
	function attemptReconnect(upstream: UpstreamConnection, attempt: number): void {
		if (shuttingDown) {
			reconnecting.delete(upstream.name);
			return;
		}
		const { initialDelayMs, maxDelayMs } = config.reconnect;
		const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
		const timer = setTimeout(async () => {
			reconnectTimers.delete(upstream.name);
			if (shuttingDown) {
				reconnecting.delete(upstream.name);
				return;
			}
			try {
				log.info({ upstream: upstream.name, attempt: attempt + 1 }, "Reconnecting to upstream");
				const fresh = await connectUpstream(upstream.config, logger);
				upstream.client = fresh.client;
				upstream.tools = fresh.tools;
				upstream.status = "up";
				wireUpstream(upstream);
				router.buildRoutes(upstreams);
				persistence?.toolRegistry.registerTools(upstream.name, upstream.tools);
				reconnecting.delete(upstream.name);
				log.info(
					{ upstream: upstream.name, toolCount: upstream.tools.length },
					"Upstream recovered",
				);
			} catch (error: unknown) {
				log.warn(
					{ upstream: upstream.name, attempt: attempt + 1, error: toError(error).message },
					"Reconnect attempt failed — retrying",
				);
				attemptReconnect(upstream, attempt + 1);
			}
		}, delay);
		timer.unref();
		reconnectTimers.set(upstream.name, timer);
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
			if (url.pathname === LEGACY_SSE_PATH || url.pathname === LEGACY_MESSAGES_PATH) {
				try {
					await handleLegacySseRequest(req, res, method, url);
					log.debug(
						{
							method,
							path: url.pathname,
							status: res.statusCode,
							durationMs: Math.round(performance.now() - startTime),
						},
						"Legacy SSE request completed",
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
						"Legacy SSE request failed",
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
			// Nothing else references this pair; close it with the response so
			// an aborted request cannot leave it behind.
			res.on("close", () => {
				void sessionServer.close();
			});
			await sessionServer.connect(transport);
			await transport.handleRequest(req, res);
			return;
		}

		// Stateful mode (/mcp): full session management with GET SSE streams.

		// Existing session — forward to its transport
		if (sessionId) {
			const session = sessions.get(sessionId);
			if (!session) {
				// 404 (not 400) is what tells an MCP client to re-initialize —
				// the normal path for a client whose session was evicted as idle.
				log.debug({ sessionId }, "Request for unknown session");
				res.writeHead(404, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32001, message: "Session not found" },
						id: null,
					}),
				);
				return;
			}
			session.lastActivity = performance.now();
			// A GET is the long-lived notification stream, not work in progress:
			// it must not keep an otherwise idle session alive.
			if (method === "POST") {
				session.inFlight++;
				res.once("close", () => {
					session.inFlight--;
					session.lastActivity = performance.now();
				});
			}
			// DELETE is handled by the transport itself: it closes, and the
			// server's onclose below drops the session from the map.
			await session.transport.handleRequest(req, res);
			return;
		}

		// New session — only POST can initialize
		if (method !== "POST") {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing session ID");
			return;
		}

		const sessionServer = createMcpServer();
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (newSessionId) => {
				evictIfAtCapacity();
				sessions.set(newSessionId, {
					transport,
					server: sessionServer,
					lastActivity: performance.now(),
					inFlight: 0,
				});
				log.debug({ sessionId: newSessionId, sessions: sessions.size }, "New session created");
			},
		});
		// Set on the server, not the transport: Protocol.connect() chains its
		// own cleanup into transport.onclose, and overwriting it skips that.
		sessionServer.onclose = () => {
			const id = transport.sessionId;
			if (id && sessions.get(id)?.transport === transport) {
				sessions.delete(id);
				log.debug({ sessionId: id, sessions: sessions.size }, "Session closed");
			}
		};
		await sessionServer.connect(transport);
		await transport.handleRequest(req, res);
	}

	/** Closes stateful sessions with no request for `sessionIdleTimeoutMs`. */
	function sweepIdleSessions(): void {
		const now = performance.now();
		const { sessionIdleTimeoutMs } = config.listen;
		for (const [id, session] of sessions) {
			if (session.inFlight === 0 && now - session.lastActivity >= sessionIdleTimeoutMs) {
				log.debug({ sessionId: id }, "Closing idle session");
				closeSession(id, session);
			}
		}
	}

	/** Makes room for one more session by closing the least recently active idle ones. */
	function evictIfAtCapacity(): void {
		const { maxSessions } = config.listen;
		if (sessions.size < maxSessions) return;
		const idle = [...sessions].filter(([, s]) => s.inFlight === 0);
		idle.sort(([, a], [, b]) => a.lastActivity - b.lastActivity);
		for (const [id, session] of idle.slice(0, sessions.size - maxSessions + 1)) {
			log.warn({ sessionId: id, maxSessions }, "Session limit reached, closing least recent");
			closeSession(id, session);
		}
	}

	function closeSession(id: string, session: HttpSession): void {
		sessions.delete(id);
		void session.server.close().catch((error: unknown) => {
			log.warn({ sessionId: id, error: toError(error).message }, "Failed to close session");
		});
	}

	/**
	 * Handles the legacy SSE transport (MCP spec 2024-11-05).
	 *
	 * Flow:
	 *   GET  /sse-legacy  → opens long-lived SSE event stream, server emits an
	 *                       `endpoint` event pointing to /messages?sessionId=...
	 *   POST /messages    → client sends JSON-RPC messages, routed by sessionId
	 *
	 * Used by clients that haven't migrated to Streamable HTTP yet (e.g. older
	 * Claude Code versions). Coexists with /mcp and /sse (Streamable HTTP).
	 */
	async function handleLegacySseRequest(
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
		method: string,
		url: URL,
	): Promise<void> {
		// GET /sse-legacy → start a new SSE event stream
		if (url.pathname === LEGACY_SSE_PATH) {
			if (method !== "GET") {
				res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
				return;
			}
			const transport = new SSEServerTransport(LEGACY_MESSAGES_PATH, res);
			const sessionServer = createMcpServer();
			const id = transport.sessionId;
			// Set on the server, not the transport, so Protocol's own close
			// cleanup still runs (see the stateful /mcp session above).
			sessionServer.onclose = () => {
				log.debug({ sessionId: id }, "Legacy SSE session closed");
				sseSessions.delete(id);
			};
			await sessionServer.connect(transport);
			sseSessions.set(id, { transport, server: sessionServer });
			log.debug({ sessionId: id }, "Legacy SSE session opened");
			return;
		}

		// POST /messages?sessionId=... → route to existing SSE session's transport
		if (method !== "POST") {
			res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
			return;
		}
		const sessionId = url.searchParams.get("sessionId");
		if (!sessionId) {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing sessionId");
			return;
		}
		const session = sseSessions.get(sessionId);
		if (!session) {
			log.warn({ sessionId }, "POST /messages for unknown SSE session");
			res.writeHead(404, { "Content-Type": "text/plain" }).end("Unknown session");
			return;
		}
		await session.transport.handlePostMessage(req, res);
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
					{
						host,
						port,
						endpoints: {
							streamableHttp: `http://${host}:${port}/mcp`,
							streamableHttpStateless: `http://${host}:${port}/sse`,
							legacySse: `http://${host}:${port}${LEGACY_SSE_PATH}`,
							legacyMessages: `http://${host}:${port}${LEGACY_MESSAGES_PATH}`,
						},
					},
					"HTTP transport listening",
				);
				resolve();
			});
		});
	}

	async function close(): Promise<void> {
		log.info({}, "Shutting down MCP Guard proxy");

		// Stand down any pending reconnect loops before tearing upstreams down,
		// so closing a client doesn't trigger a fresh reconnect via onclose.
		shuttingDown = true;
		for (const timer of reconnectTimers.values()) {
			clearTimeout(timer);
		}
		reconnectTimers.clear();
		reconnecting.clear();

		// Race cleanup against a 5-second timeout
		const SHUTDOWN_TIMEOUT_MS = 5000;
		const cleanup = async (): Promise<void> => {
			if (cleanupInterval) {
				clearInterval(cleanupInterval);
			}
			if (sessionSweepInterval) {
				clearInterval(sessionSweepInterval);
			}
			// Close all HTTP sessions
			for (const [id, session] of sessions) {
				log.debug({ sessionId: id }, "Closing session on shutdown");
				await session.server.close();
			}
			sessions.clear();
			// Close all legacy SSE sessions
			for (const [id, session] of sseSessions) {
				log.debug({ sessionId: id }, "Closing legacy SSE session on shutdown");
				await session.server.close();
			}
			sseSessions.clear();
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
