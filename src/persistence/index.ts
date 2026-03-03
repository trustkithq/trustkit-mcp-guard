import type Database from "better-sqlite3";
import type { AuditEvent, AuditSink } from "../audit/logger.js";
import type { AuditConfig } from "../config/schema.js";
import type { Logger } from "../logger/index.js";
import { AuditStore } from "./audit-store.js";
import { closeDatabase, openDatabase } from "./database.js";
import { StatsStore } from "./stats-store.js";
import { ToolRegistryStore } from "./tool-registry.js";

export interface Persistence {
	/** Audit event store. */
	auditStore: AuditStore;
	/** Tool registry store. */
	toolRegistry: ToolRegistryStore;
	/** Stats store. */
	statsStore: StatsStore;
	/** Returns an AuditSink that writes events to SQLite. */
	createSink(): AuditSink;
	/** Run cleanup (remove old events). */
	cleanup(): void;
	/** Close the database. */
	close(): void;
}

/**
 * Initializes the persistence layer if audit.dbPath is configured.
 * Returns null if persistence is disabled (dbPath === false).
 */
export function initPersistence(config: AuditConfig, logger: Logger): Persistence | null {
	if (config.dbPath === false) {
		logger.info({}, "Persistence disabled (audit.dbPath = false)");
		return null;
	}

	const db = openDatabase({ dbPath: config.dbPath, logger });
	const auditStore = new AuditStore(db, logger, config.retentionHours);
	const toolRegistry = new ToolRegistryStore(db, logger);
	const statsStore = new StatsStore(db, logger);

	function createSink(): AuditSink {
		return (event: AuditEvent) => {
			auditStore.write(event);
			statsStore.record(event);
		};
	}

	function cleanup(): void {
		auditStore.cleanup();
	}

	function close(): void {
		closeDatabase(db, logger);
	}

	return { auditStore, toolRegistry, statsStore, createSink, cleanup, close };
}

export { AuditStore } from "./audit-store.js";
export { StatsStore, type ToolStats } from "./stats-store.js";
export { ToolRegistryStore, type ToolRegistryEntry } from "./tool-registry.js";
export { openDatabase, closeDatabase } from "./database.js";
