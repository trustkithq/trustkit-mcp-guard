import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors/base.js";
import { createLogger } from "../logger/index.js";
import { ToolRouter } from "../proxy/router.js";
import type { UpstreamConnection } from "../proxy/upstream.js";

const logger = createLogger({ level: "silent" });

function makeTool(name: string): Tool {
	return {
		name,
		description: `Tool ${name}`,
		inputSchema: { type: "object" as const },
	};
}

function makeUpstream(name: string, tools: Tool[]): UpstreamConnection {
	return {
		name,
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		client: {} as any,
		tools,
		status: "up",
	};
}

describe("ToolRouter", () => {
	it("builds routes from a single upstream", () => {
		const router = new ToolRouter(logger);
		const upstream = makeUpstream("fs", [makeTool("read_file"), makeTool("write_file")]);

		router.buildRoutes([upstream]);

		expect(router.size).toBe(2);
		expect(router.resolve("read_file")?.upstream.name).toBe("fs");
		expect(router.resolve("write_file")?.upstream.name).toBe("fs");
	});

	it("builds routes from multiple upstreams", () => {
		const router = new ToolRouter(logger);
		const fs = makeUpstream("fs", [makeTool("read_file")]);
		const github = makeUpstream("github", [makeTool("create_issue")]);

		router.buildRoutes([fs, github]);

		expect(router.size).toBe(2);
		expect(router.resolve("read_file")?.upstream.name).toBe("fs");
		expect(router.resolve("create_issue")?.upstream.name).toBe("github");
	});

	it("returns undefined for unknown tools", () => {
		const router = new ToolRouter(logger);
		router.buildRoutes([makeUpstream("fs", [makeTool("read_file")])]);

		expect(router.resolve("nonexistent")).toBeUndefined();
	});

	it("returns aggregated tool list", () => {
		const router = new ToolRouter(logger);
		const fs = makeUpstream("fs", [makeTool("read_file")]);
		const github = makeUpstream("github", [makeTool("create_issue")]);

		router.buildRoutes([fs, github]);

		const tools = router.allTools();
		expect(tools).toHaveLength(2);
		expect(tools.map((t) => t.name).sort()).toEqual(["create_issue", "read_file"]);
	});

	it("throws ValidationError on tool name collision", () => {
		const router = new ToolRouter(logger);
		const fs = makeUpstream("fs", [makeTool("read_file")]);
		const other = makeUpstream("other-fs", [makeTool("read_file")]);

		expect(() => router.buildRoutes([fs, other])).toThrow(ValidationError);
		try {
			router.buildRoutes([fs, other]);
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain("read_file");
			expect((error as ValidationError).message).toContain("fs");
			expect((error as ValidationError).message).toContain("other-fs");
		}
	});

	it("replaces routes on rebuild", () => {
		const router = new ToolRouter(logger);
		router.buildRoutes([makeUpstream("fs", [makeTool("read_file"), makeTool("write_file")])]);
		expect(router.size).toBe(2);

		// Rebuild with different tools
		router.buildRoutes([makeUpstream("github", [makeTool("create_issue")])]);
		expect(router.size).toBe(1);
		expect(router.resolve("read_file")).toBeUndefined();
		expect(router.resolve("create_issue")?.upstream.name).toBe("github");
	});

	it("preserves tool definition in route entry", () => {
		const router = new ToolRouter(logger);
		const tool = makeTool("read_file");
		router.buildRoutes([makeUpstream("fs", [tool])]);

		const entry = router.resolve("read_file");
		expect(entry?.tool).toBe(tool);
		expect(entry?.tool.name).toBe("read_file");
		expect(entry?.tool.description).toBe("Tool read_file");
	});

	it("handles empty upstream list", () => {
		const router = new ToolRouter(logger);
		router.buildRoutes([]);
		expect(router.size).toBe(0);
		expect(router.allTools()).toEqual([]);
	});

	it("handles upstream with no tools", () => {
		const router = new ToolRouter(logger);
		router.buildRoutes([makeUpstream("empty", [])]);
		expect(router.size).toBe(0);
	});
});
