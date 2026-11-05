import { z } from "zod";

// --- Transport types ---

const transportSchema = z.enum(["stdio", "http"]);

// --- Listen (agent-facing) ---

const listenSchema = z
	.object({
		/** Transport for the agent-facing side. */
		transport: transportSchema.default("stdio"),
		/** HTTP port (only used when transport is "http"). */
		port: z.number().int().min(1).max(65535).default(31415),
		/** HTTP host (only used when transport is "http"). */
		host: z.string().default("0.0.0.0"),
		/**
		 * Close a stateful HTTP session after this long (ms) without a request.
		 * Clients rarely send DELETE when they go away, so without this every
		 * abandoned session stays in memory forever. A client that comes back
		 * later gets 404 and re-initializes, as the MCP spec requires.
		 */
		sessionIdleTimeoutMs: z.number().int().positive().default(1_800_000),
		/** Upper bound on concurrent stateful HTTP sessions; the least recently active is closed first. */
		maxSessions: z.number().int().positive().default(1000),
	})
	.default({});

// --- Upstream server definitions ---

/**
 * Fields shared by every upstream server regardless of transport.
 *
 * The timeout fields control how long a single forwarded `tools/call` may run
 * before it fails. A request that exceeds the timeout fails with a timeout
 * error but does NOT take the upstream down — the connection stays healthy for
 * subsequent calls.
 */
const baseServerFields = {
	name: z.string().min(1),
	/**
	 * Per-request timeout (ms) for a forwarded tool call. Long-running tools
	 * (e.g. heavy analytical queries) need a higher value than the MCP SDK's
	 * 60s default.
	 */
	requestTimeoutMs: z.number().int().positive().default(60000),
	/** Reset the request timeout whenever the upstream sends a progress notification. */
	resetTimeoutOnProgress: z.boolean().default(false),
	/**
	 * Absolute cap (ms) on a single request even when progress notifications
	 * keep resetting the timeout. Unset means no cap beyond requestTimeoutMs.
	 */
	maxTotalTimeoutMs: z.number().int().positive().optional(),
};

const stdioServerSchema = z.object({
	...baseServerFields,
	transport: z.literal("stdio"),
	/** Command to spawn the MCP server. */
	command: z.string().min(1),
	/** Arguments for the command. */
	args: z.array(z.string()).default([]),
	/** Environment variables for the child process. */
	env: z.record(z.string()).optional(),
	/** Working directory for the child process. */
	cwd: z.string().optional(),
});

const httpServerSchema = z.object({
	...baseServerFields,
	transport: z.literal("http"),
	/** URL of the remote MCP server. */
	url: z.string().url(),
});

const serverSchema = z.discriminatedUnion("transport", [stdioServerSchema, httpServerSchema]);

// --- Policy rules ---

const toolRuleSchema = z.object({
	/** Tool name or glob pattern (e.g. "read_file", "github_*"). */
	tool: z.string().min(1),
	/** Whether this tool is allowed. */
	allow: z.boolean().default(true),
	/** If true, only read operations are permitted. */
	readOnly: z.boolean().optional(),
});

// --- Audit configuration ---

const auditSchema = z
	.object({
		/** Path to SQLite database file. Set to false to disable persistence. */
		dbPath: z.union([z.string(), z.literal(false)]).default("~/.mcp-guard/guard.db"),
		/** Rolling window for audit event retention in hours. */
		retentionHours: z.number().int().min(1).default(24),
	})
	.default({});

// --- Reconnect configuration ---

const reconnectSchema = z
	.object({
		/**
		 * Auto-reconnect an upstream after its transport dies, instead of
		 * latching it off until the whole process restarts.
		 */
		enabled: z.boolean().default(true),
		/** Initial backoff delay (ms) before the first reconnect attempt. */
		initialDelayMs: z.number().int().positive().default(1000),
		/** Maximum backoff delay (ms) between reconnect attempts. */
		maxDelayMs: z.number().int().positive().default(30000),
	})
	.default({});

// --- Full guard config ---

export const guardConfigSchema = z.object({
	/** Config version for forward compatibility. */
	version: z.literal(1),

	/** Agent-facing transport configuration. */
	listen: listenSchema,

	/** Upstream MCP servers to connect to. */
	servers: z.array(serverSchema).min(1, "At least one upstream server is required"),

	/** Policy rules. */
	policy: z.object({
		/** Default action when no rule matches. */
		defaultAction: z.enum(["allow", "deny"]).default("deny"),
		/** Ordered list of tool rules — first match wins. */
		rules: z.array(toolRuleSchema).default([]),
	}),

	/** Audit and persistence configuration. */
	audit: auditSchema,

	/** How to recover an upstream after a transport-level disconnect. */
	reconnect: reconnectSchema,

	/** Logging level. */
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// --- Types ---

export type GuardConfig = z.infer<typeof guardConfigSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type ListenConfig = z.infer<typeof listenSchema>;
export type AuditConfig = z.infer<typeof auditSchema>;
export type ReconnectConfig = z.infer<typeof reconnectSchema>;
export type ToolRule = z.infer<typeof toolRuleSchema>;
