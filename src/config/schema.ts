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
	})
	.default({});

// --- Upstream server definitions ---

const stdioServerSchema = z.object({
	name: z.string().min(1),
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
	name: z.string().min(1),
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

	/** Logging level. */
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// --- Types ---

export type GuardConfig = z.infer<typeof guardConfigSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type ListenConfig = z.infer<typeof listenSchema>;
export type ToolRule = z.infer<typeof toolRuleSchema>;
