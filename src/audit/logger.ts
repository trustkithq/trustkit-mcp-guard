import type { Logger } from "../logger/index.js";

export interface AuditEvent {
	timestamp: string;
	tool: string;
	allowed: boolean;
	reason: string;
	requestId?: string | number;
	upstreamName?: string;
}

/**
 * Structured audit logger for tool call decisions.
 * Outputs JSON lines to stderr via the application logger.
 */
export class AuditLogger {
	private readonly events: AuditEvent[] = [];
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger.child({ component: "audit" });
	}

	/** Log a policy decision as an audit event. */
	log(event: Omit<AuditEvent, "timestamp">): void {
		const entry: AuditEvent = {
			...event,
			timestamp: new Date().toISOString(),
		};
		this.events.push(entry);
		this.logger.info(
			{
				tool: entry.tool,
				allowed: entry.allowed,
				reason: entry.reason,
				requestId: entry.requestId,
				upstreamName: entry.upstreamName,
			},
			entry.allowed ? "Tool call allowed" : "Tool call denied",
		);
	}

	/** Get all recorded events (useful for testing). */
	getEvents(): readonly AuditEvent[] {
		return this.events;
	}
}
