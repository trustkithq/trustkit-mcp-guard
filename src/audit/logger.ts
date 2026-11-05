import { randomUUID } from "node:crypto";
import type { Logger } from "../logger/index.js";

export interface AuditEvent {
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** Session-level correlation ID (UUID v4). */
	correlationId: string;
	/** JSON-RPC request ID. */
	requestId?: string | number;
	/** Tool name. */
	tool: string;
	/** Upstream server name. */
	serverName?: string;
	/** Whether the call was allowed. */
	allowed: boolean;
	/** Reason from policy evaluation. */
	reason: string;
	/** Duration in milliseconds (includes upstream round-trip for allowed calls). */
	durationMs?: number;
	/** Error message if upstream call failed. */
	error?: string;
}

/** Callback for audit event consumers (e.g. SQLite persistence). */
export type AuditSink = (event: AuditEvent) => void;

/**
 * Structured audit logger for tool call decisions.
 * Outputs JSON lines to stderr via the application logger.
 * Supports additional sinks for persistence.
 */
export class AuditLogger {
	private readonly events: AuditEvent[] = [];
	private readonly logger: Logger;
	private readonly sinks: AuditSink[] = [];
	private readonly maxEvents: number;

	/** Session-level correlation ID, shared across all events in this session. */
	readonly correlationId: string;

	/**
	 * @param maxEvents How many recent events `getEvents()` keeps in memory.
	 *   The logger lives as long as the process, so this must stay bounded;
	 *   durable history belongs in a sink.
	 */
	constructor(logger: Logger, correlationId?: string, maxEvents = 1000) {
		this.logger = logger.child({ component: "audit" });
		this.correlationId = correlationId ?? randomUUID();
		this.maxEvents = maxEvents;
	}

	/** Register an additional sink for audit events (e.g. SQLite writer). */
	addSink(sink: AuditSink): void {
		this.sinks.push(sink);
	}

	/** Log a policy decision as an audit event. */
	log(event: Omit<AuditEvent, "timestamp" | "correlationId">): void {
		const entry: AuditEvent = {
			...event,
			timestamp: new Date().toISOString(),
			correlationId: this.correlationId,
		};
		this.events.push(entry);
		if (this.events.length > this.maxEvents) {
			this.events.shift();
		}

		this.logger.info(
			{
				correlationId: entry.correlationId,
				requestId: entry.requestId,
				tool: entry.tool,
				serverName: entry.serverName,
				allowed: entry.allowed,
				reason: entry.reason,
				durationMs: entry.durationMs,
				error: entry.error,
			},
			entry.allowed ? "Tool call allowed" : "Tool call denied",
		);

		for (const sink of this.sinks) {
			sink(entry);
		}
	}

	/** Get the most recent recorded events, up to `maxEvents` (useful for testing). */
	getEvents(): readonly AuditEvent[] {
		return this.events;
	}
}
