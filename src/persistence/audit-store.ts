import type Database from "better-sqlite3";
import type { AuditEvent } from "../audit/logger.js";
import type { Logger } from "../logger/index.js";

/**
 * Persists audit events to SQLite and manages rolling window cleanup.
 */
export class AuditStore {
	private readonly db: Database.Database;
	private readonly logger: Logger;
	private readonly insertStmt: Database.Statement;
	private readonly cleanupStmt: Database.Statement;
	private readonly retentionHours: number;

	constructor(db: Database.Database, logger: Logger, retentionHours: number) {
		this.db = db;
		this.logger = logger.child({ component: "audit-store" });
		this.retentionHours = retentionHours;

		this.insertStmt = db.prepare(`
			INSERT INTO audit_events (timestamp, correlation_id, request_id, tool, server_name, allowed, reason, duration_ms, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.cleanupStmt = db.prepare(`
			DELETE FROM audit_events WHERE datetime(timestamp) < datetime('now', ?)
		`);
	}

	/** Write a single audit event to SQLite. */
	write(event: AuditEvent): void {
		this.insertStmt.run(
			event.timestamp,
			event.correlationId,
			event.requestId != null ? String(event.requestId) : null,
			event.tool,
			event.serverName ?? null,
			event.allowed ? 1 : 0,
			event.reason,
			event.durationMs ?? null,
			event.error ?? null,
		);
	}

	/** Remove audit events older than the retention window. */
	cleanup(): number {
		const result = this.cleanupStmt.run(`-${this.retentionHours} hours`);
		if (result.changes > 0) {
			this.logger.info(
				{ removed: result.changes, retentionHours: this.retentionHours },
				"Audit cleanup completed",
			);
		}
		return result.changes;
	}

	/** Count total audit events in the database. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM audit_events").get() as {
			cnt: number;
		};
		return row.cnt;
	}

	/** Query recent audit events (most recent first). */
	recent(limit = 100): AuditEvent[] {
		const rows = this.db
			.prepare(
				`SELECT timestamp, correlation_id, request_id, tool, server_name, allowed, reason, duration_ms, error
				 FROM audit_events ORDER BY id DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			timestamp: string;
			correlation_id: string;
			request_id: string | null;
			tool: string;
			server_name: string | null;
			allowed: number;
			reason: string;
			duration_ms: number | null;
			error: string | null;
		}>;

		return rows.map((row) => ({
			timestamp: row.timestamp,
			correlationId: row.correlation_id,
			requestId: row.request_id ?? undefined,
			tool: row.tool,
			serverName: row.server_name ?? undefined,
			allowed: row.allowed === 1,
			reason: row.reason,
			durationMs: row.duration_ms ?? undefined,
			error: row.error ?? undefined,
		}));
	}
}
