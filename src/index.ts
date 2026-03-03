// Config
export { loadConfig } from "./config/loader.js";
export { type GuardConfig, guardConfigSchema } from "./config/schema.js";
export type {
	ServerConfig,
	StdioServerConfig,
	HttpServerConfig,
	ListenConfig,
	AuditConfig,
} from "./config/schema.js";

// Errors
export {
	AppError,
	ValidationError,
	PolicyError,
	NetworkError,
	AuditError,
	toError,
	toAppError,
} from "./errors/base.js";

// Logger
export { createLogger, formatError } from "./logger/index.js";
export type { Logger } from "./logger/index.js";

// Policy
export { PolicyEngine } from "./policy/engine.js";
export type { PolicyDecision, PolicyInput } from "./policy/engine.js";
export { type PolicyConfig, policyConfigSchema } from "./policy/schema.js";

// Audit
export { AuditLogger, type AuditEvent, type AuditSink } from "./audit/logger.js";

// Persistence
export { initPersistence, AuditStore, StatsStore, ToolRegistryStore } from "./persistence/index.js";
export type { Persistence, ToolStats, ToolRegistryEntry } from "./persistence/index.js";

// Proxy
export { createProxy, type McpGuardProxy } from "./proxy/index.js";
export { ToolRouter, type RouteEntry } from "./proxy/router.js";
export type { UpstreamConnection } from "./proxy/upstream.js";
