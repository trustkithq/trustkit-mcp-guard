import { AuditLogger } from "./audit/logger.js";
import { PolicyEngine } from "./policy/engine.js";
import type { PolicyConfig } from "./policy/schema.js";

export interface ProxyOptions {
	config: PolicyConfig;
}

/**
 * Creates an MCP Guard proxy that sits between an AI client and an MCP server.
 * Intercepts tool calls, validates them against policy, and produces audit events.
 */
export function createProxy(options: ProxyOptions) {
	const engine = new PolicyEngine(options.config);
	const logger = new AuditLogger();

	return {
		engine,
		logger,
		// TODO: implement MCP transport proxying
	};
}
