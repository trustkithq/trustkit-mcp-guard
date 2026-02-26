export interface AuditEvent {
	timestamp: string;
	tool: string;
	allowed: boolean;
	reason: string;
	args?: Record<string, unknown>;
}

/**
 * Structured audit logger for tool call decisions.
 * Outputs JSON lines to stdout by default.
 */
export class AuditLogger {
	private readonly events: AuditEvent[] = [];

	/** Log a policy decision as an audit event. */
	log(event: Omit<AuditEvent, "timestamp">): void {
		const entry: AuditEvent = {
			...event,
			timestamp: new Date().toISOString(),
		};
		this.events.push(entry);
		console.log(JSON.stringify(entry));
	}

	/** Get all recorded events (useful for testing). */
	getEvents(): readonly AuditEvent[] {
		return this.events;
	}
}
