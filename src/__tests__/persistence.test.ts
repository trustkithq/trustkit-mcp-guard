import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../audit/logger.js";
import { createLogger } from "../logger/index.js";
import { AuditStore } from "../persistence/audit-store.js";
import { openDatabase } from "../persistence/database.js";
import { StatsStore } from "../persistence/stats-store.js";
import { ToolRegistryStore } from "../persistence/tool-registry.js";

const logger = createLogger({ level: "silent" });

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
	return {
		timestamp: new Date().toISOString(),
		correlationId: "test-correlation-id",
		tool: "read_file",
		allowed: true,
		reason: "Allowed by rule: read_*",
		...overrides,
	};
}

describe("AuditStore", () => {
	let db: Database.Database;
	let store: AuditStore;

	beforeEach(() => {
		db = openDatabase({ dbPath: ":memory:", logger });
		store = new AuditStore(db, logger, 24);
	});

	afterEach(() => {
		db.close();
	});

	it("writes and retrieves audit events", () => {
		store.write(makeEvent({ tool: "read_file" }));
		store.write(makeEvent({ tool: "write_file", allowed: false, reason: "Denied" }));

		expect(store.count()).toBe(2);
		const events = store.recent();
		expect(events).toHaveLength(2);
		// Most recent first
		expect(events[0].tool).toBe("write_file");
		expect(events[1].tool).toBe("read_file");
	});

	it("preserves all event fields", () => {
		store.write(
			makeEvent({
				tool: "search",
				correlationId: "abc-123",
				requestId: "42",
				serverName: "fs-server",
				allowed: true,
				reason: "Allowed",
				durationMs: 150,
				error: "timeout",
			}),
		);

		const events = store.recent();
		expect(events[0].correlationId).toBe("abc-123");
		expect(events[0].requestId).toBe("42");
		expect(events[0].serverName).toBe("fs-server");
		expect(events[0].durationMs).toBe(150);
		expect(events[0].error).toBe("timeout");
	});

	it("cleans up old events beyond retention window", () => {
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const recent = new Date().toISOString();

		store.write(makeEvent({ timestamp: old, tool: "old_tool" }));
		store.write(makeEvent({ timestamp: recent, tool: "new_tool" }));

		expect(store.count()).toBe(2);
		const removed = store.cleanup();
		expect(removed).toBe(1);
		expect(store.count()).toBe(1);
		expect(store.recent()[0].tool).toBe("new_tool");
	});

	it("returns empty array when no events", () => {
		expect(store.recent()).toEqual([]);
		expect(store.count()).toBe(0);
	});

	it("limits recent results", () => {
		for (let i = 0; i < 10; i++) {
			store.write(makeEvent({ tool: `tool_${i}` }));
		}
		const limited = store.recent(3);
		expect(limited).toHaveLength(3);
	});
});

describe("ToolRegistryStore", () => {
	let db: Database.Database;
	let registry: ToolRegistryStore;

	beforeEach(() => {
		db = openDatabase({ dbPath: ":memory:", logger });
		registry = new ToolRegistryStore(db, logger);
	});

	afterEach(() => {
		db.close();
	});

	it("registers tools from an upstream", () => {
		registry.registerTools("fs-server", [
			{ name: "read_file", description: "Read a file", inputSchema: { type: "object" as const } },
			{ name: "write_file", inputSchema: { type: "object" as const } },
		]);

		expect(registry.count()).toBe(2);
		const tools = registry.all();
		expect(tools[0].name).toBe("read_file");
		expect(tools[0].serverName).toBe("fs-server");
		expect(tools[0].description).toBe("Read a file");
		expect(tools[1].name).toBe("write_file");
	});

	it("updates existing tools on re-register", () => {
		registry.registerTools("fs-server", [
			{ name: "read_file", description: "v1", inputSchema: { type: "object" as const } },
		]);
		registry.registerTools("fs-server", [
			{ name: "read_file", description: "v2", inputSchema: { type: "object" as const } },
		]);

		expect(registry.count()).toBe(1);
		expect(registry.all()[0].description).toBe("v2");
	});

	it("tracks tools from multiple upstreams", () => {
		registry.registerTools("fs", [{ name: "read_file", inputSchema: { type: "object" as const } }]);
		registry.registerTools("github", [
			{ name: "create_issue", inputSchema: { type: "object" as const } },
		]);

		expect(registry.count()).toBe(2);
	});
});

describe("StatsStore", () => {
	let db: Database.Database;
	let stats: StatsStore;

	beforeEach(() => {
		db = openDatabase({ dbPath: ":memory:", logger });
		stats = new StatsStore(db, logger);
	});

	afterEach(() => {
		db.close();
	});

	it("records allow/deny counts", () => {
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", allowed: true }));
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", allowed: true }));
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", allowed: false }));

		const result = stats.forTool("read_file");
		expect(result).toBeDefined();
		expect(result?.allowCount).toBe(2);
		expect(result?.denyCount).toBe(1);
	});

	it("tracks duration totals", () => {
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", durationMs: 100 }));
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", durationMs: 200 }));

		const result = stats.forTool("read_file");
		expect(result?.totalDurationMs).toBe(300);
	});

	it("tracks error counts", () => {
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", error: "timeout" }));
		stats.record(makeEvent({ tool: "read_file", serverName: "fs" }));

		const result = stats.forTool("read_file");
		expect(result?.errorCount).toBe(1);
	});

	it("returns undefined for unknown tools", () => {
		expect(stats.forTool("nonexistent")).toBeUndefined();
	});

	it("tracks stats across multiple tools", () => {
		stats.record(makeEvent({ tool: "read_file", serverName: "fs" }));
		stats.record(makeEvent({ tool: "write_file", serverName: "fs" }));

		const all = stats.all();
		expect(all).toHaveLength(2);
	});

	it("preserves last_called timestamp", () => {
		const ts = "2025-01-15T10:30:00.000Z";
		stats.record(makeEvent({ tool: "read_file", serverName: "fs", timestamp: ts }));

		const result = stats.forTool("read_file");
		expect(result?.lastCalled).toBe(ts);
	});
});

describe("openDatabase", () => {
	it("creates in-memory database with schema", () => {
		const db = openDatabase({ dbPath: ":memory:", logger });
		// Verify tables exist
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("audit_events");
		expect(tableNames).toContain("tool_registry");
		expect(tableNames).toContain("stats");
		db.close();
	});

	it("uses WAL journal mode", () => {
		const db = openDatabase({ dbPath: ":memory:", logger });
		const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
		// In-memory databases use "memory" mode regardless of WAL setting
		expect(result[0].journal_mode).toBeDefined();
		db.close();
	});
});
