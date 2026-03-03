import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { AuditError } from "../errors/base.js";
import { toError } from "../errors/base.js";
import type { Logger } from "../logger/index.js";

export interface DatabaseOptions {
	/** Path to SQLite database file. Use ":memory:" for in-memory DB. */
	dbPath: string;
	/** Logger instance. */
	logger: Logger;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp TEXT NOT NULL,
	correlation_id TEXT NOT NULL,
	request_id TEXT,
	tool TEXT NOT NULL,
	server_name TEXT,
	allowed INTEGER NOT NULL,
	reason TEXT NOT NULL,
	duration_ms INTEGER,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events(correlation_id);

CREATE TABLE IF NOT EXISTS tool_registry (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	server_name TEXT NOT NULL,
	description TEXT,
	input_schema TEXT,
	last_seen TEXT NOT NULL,
	UNIQUE(name, server_name)
);

CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_registry(name);

CREATE TABLE IF NOT EXISTS stats (
	tool TEXT NOT NULL,
	server_name TEXT NOT NULL,
	allow_count INTEGER NOT NULL DEFAULT 0,
	deny_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	total_duration_ms INTEGER NOT NULL DEFAULT 0,
	last_called TEXT,
	PRIMARY KEY (tool, server_name)
);
`;

/**
 * Opens (or creates) the SQLite database and applies the schema.
 * Resolves ~ in path. Creates parent directories if needed.
 */
export function openDatabase(options: DatabaseOptions): Database.Database {
	const { logger } = options;
	const log = logger.child({ component: "database" });
	const dbPath = resolvePath(options.dbPath);

	if (dbPath !== ":memory:") {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			log.debug({ dir }, "Created database directory");
		}
	}

	try {
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.exec(SCHEMA_SQL);
		log.info({ dbPath }, "Database opened");
		return db;
	} catch (error: unknown) {
		const err = toError(error);
		log.error({ dbPath, error: err.message }, "Failed to open database");
		throw err;
	}
}

/**
 * Closes the database connection gracefully.
 */
export function closeDatabase(db: Database.Database, logger: Logger): void {
	try {
		db.close();
		logger.debug({}, "Database closed");
	} catch (error: unknown) {
		logger.warn({ error: toError(error).message }, "Error closing database");
	}
}

function resolvePath(dbPath: string): string {
	if (dbPath === ":memory:") return dbPath;
	if (dbPath.startsWith("~/")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
		return resolve(home, dbPath.slice(2));
	}
	return resolve(dbPath);
}
