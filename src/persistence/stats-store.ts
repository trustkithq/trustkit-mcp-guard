import type Database from "better-sqlite3";
import type { AuditEvent } from "../audit/logger.js";
import type { Logger } from "../logger/index.js";

export interface ToolStats {
	tool: string;
	serverName: string;
	allowCount: number;
	denyCount: number;
	errorCount: number;
	totalDurationMs: number;
	lastCalled?: string;
}

/**
 * Maintains per-tool call statistics in SQLite.
 */
export class StatsStore {
	private readonly db: Database.Database;
	private readonly logger: Logger;
	private readonly upsertStmt: Database.Statement;

	constructor(db: Database.Database, logger: Logger) {
		this.db = db;
		this.logger = logger.child({ component: "stats-store" });

		this.upsertStmt = db.prepare(`
			INSERT INTO stats (tool, server_name, allow_count, deny_count, error_count, total_duration_ms, last_called)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(tool, server_name)
			DO UPDATE SET
				allow_count = stats.allow_count + excluded.allow_count,
				deny_count = stats.deny_count + excluded.deny_count,
				error_count = stats.error_count + excluded.error_count,
				total_duration_ms = stats.total_duration_ms + excluded.total_duration_ms,
				last_called = excluded.last_called
		`);
	}

	/** Record a tool call from an audit event. */
	record(event: AuditEvent): void {
		this.upsertStmt.run(
			event.tool,
			event.serverName ?? "unknown",
			event.allowed ? 1 : 0,
			event.allowed ? 0 : 1,
			event.error ? 1 : 0,
			event.durationMs ?? 0,
			event.timestamp,
		);
	}

	/** Get stats for all tools. */
	all(): ToolStats[] {
		const rows = this.db
			.prepare(
				"SELECT tool, server_name, allow_count, deny_count, error_count, total_duration_ms, last_called FROM stats ORDER BY tool",
			)
			.all() as Array<{
			tool: string;
			server_name: string;
			allow_count: number;
			deny_count: number;
			error_count: number;
			total_duration_ms: number;
			last_called: string | null;
		}>;
		return rows.map((row) => ({
			tool: row.tool,
			serverName: row.server_name,
			allowCount: row.allow_count,
			denyCount: row.deny_count,
			errorCount: row.error_count,
			totalDurationMs: row.total_duration_ms,
			lastCalled: row.last_called ?? undefined,
		}));
	}

	/** Get stats for a specific tool. */
	forTool(toolName: string): ToolStats | undefined {
		const row = this.db
			.prepare(
				"SELECT tool, server_name, allow_count, deny_count, error_count, total_duration_ms, last_called FROM stats WHERE tool = ?",
			)
			.get(toolName) as
			| {
					tool: string;
					server_name: string;
					allow_count: number;
					deny_count: number;
					error_count: number;
					total_duration_ms: number;
					last_called: string | null;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			tool: row.tool,
			serverName: row.server_name,
			allowCount: row.allow_count,
			denyCount: row.deny_count,
			errorCount: row.error_count,
			totalDurationMs: row.total_duration_ms,
			lastCalled: row.last_called ?? undefined,
		};
	}
}
