import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import type { Logger } from "../logger/index.js";

export interface ToolRegistryEntry {
	name: string;
	serverName: string;
	description?: string;
	inputSchema?: string;
	lastSeen: string;
}

/**
 * Tracks discovered tools and their upstream server mappings in SQLite.
 */
export class ToolRegistryStore {
	private readonly db: Database.Database;
	private readonly logger: Logger;
	private readonly upsertStmt: Database.Statement;

	constructor(db: Database.Database, logger: Logger) {
		this.db = db;
		this.logger = logger.child({ component: "tool-registry" });

		this.upsertStmt = db.prepare(`
			INSERT INTO tool_registry (name, server_name, description, input_schema, last_seen)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(name, server_name)
			DO UPDATE SET description = excluded.description, input_schema = excluded.input_schema, last_seen = excluded.last_seen
		`);
	}

	/** Register tools discovered from an upstream server. */
	registerTools(serverName: string, tools: Tool[]): void {
		const now = new Date().toISOString();
		const upsertMany = this.db.transaction((items: Tool[]) => {
			for (const tool of items) {
				this.upsertStmt.run(
					tool.name,
					serverName,
					tool.description ?? null,
					JSON.stringify(tool.inputSchema),
					now,
				);
			}
		});
		upsertMany(tools);
		this.logger.debug({ serverName, toolCount: tools.length }, "Tool registry updated");
	}

	/** Get all registered tools. */
	all(): ToolRegistryEntry[] {
		const rows = this.db
			.prepare(
				"SELECT name, server_name, description, input_schema, last_seen FROM tool_registry ORDER BY name",
			)
			.all() as Array<{
			name: string;
			server_name: string;
			description: string | null;
			input_schema: string | null;
			last_seen: string;
		}>;
		return rows.map((row) => ({
			name: row.name,
			serverName: row.server_name,
			description: row.description ?? undefined,
			inputSchema: row.input_schema ?? undefined,
			lastSeen: row.last_seen,
		}));
	}

	/** Count registered tools. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM tool_registry").get() as {
			cnt: number;
		};
		return row.cnt;
	}
}
