import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ValidationError } from "../errors/base.js";
import type { Logger } from "../logger/index.js";
import type { UpstreamConnection } from "./upstream.js";

export interface RouteEntry {
	/** The upstream connection that owns this tool. */
	upstream: UpstreamConnection;
	/** The tool definition from the upstream. */
	tool: Tool;
}

/**
 * Maps tool names to their upstream connections.
 * Built at startup from discovered tools; rebuilt on tools/list_changed.
 */
export class ToolRouter {
	private readonly routes = new Map<string, RouteEntry>();
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger.child({ component: "router" });
	}

	/**
	 * Builds the routing table from upstream connections.
	 * Throws ValidationError on tool name collisions.
	 */
	buildRoutes(connections: UpstreamConnection[]): void {
		const newRoutes = new Map<string, RouteEntry>();

		for (const upstream of connections) {
			for (const tool of upstream.tools) {
				const existing = newRoutes.get(tool.name);
				if (existing) {
					throw new ValidationError(
						`Tool name collision: "${tool.name}" is provided by both ` +
							`"${existing.upstream.name}" and "${upstream.name}"`,
						{
							context: {
								tool: tool.name,
								upstreams: [existing.upstream.name, upstream.name],
							},
						},
					);
				}
				newRoutes.set(tool.name, { upstream, tool });
			}
		}

		this.routes.clear();
		for (const [name, entry] of newRoutes) {
			this.routes.set(name, entry);
		}

		this.logger.info(
			{ toolCount: this.routes.size, upstreams: connections.map((c) => c.name) },
			"Routing table built",
		);
	}

	/** Looks up the route for a tool by name. Returns undefined if not found. */
	resolve(toolName: string): RouteEntry | undefined {
		return this.routes.get(toolName);
	}

	/** Returns all tools from all upstreams (aggregated list). */
	allTools(): Tool[] {
		return Array.from(this.routes.values()).map((entry) => entry.tool);
	}

	/** Number of registered tool routes. */
	get size(): number {
		return this.routes.size;
	}
}
