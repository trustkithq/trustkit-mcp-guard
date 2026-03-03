import { afterEach, describe, expect, it } from "vitest";
import type { E2EContext } from "./helpers.js";
import { setupProxy } from "./helpers.js";

describe("E2E: Policy enforcement", () => {
	let ctx: E2EContext;

	afterEach(async () => {
		await ctx?.cleanup();
	});

	it("allows a tool call that matches an allow rule", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [{ tool: "read_file", allow: true }],
			},
		});

		const result = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "file contents here" }]);
	});

	it("blocks a tool call that matches a deny rule", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "allow",
				rules: [{ tool: "write_file", allow: false }],
			},
		});

		await expect(ctx.client.callTool({ name: "write_file", arguments: {} })).rejects.toThrow(
			/denied/i,
		);
	});

	it("falls back to default deny when no rule matches", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [{ tool: "read_file", allow: true }],
			},
		});

		await expect(ctx.client.callTool({ name: "search_files", arguments: {} })).rejects.toThrow(
			/denied/i,
		);
	});

	it("falls back to default allow when no rule matches", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "allow",
				rules: [{ tool: "write_file", allow: false }],
			},
		});

		const result = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "file contents here" }]);
	});

	it("supports glob patterns with trailing wildcard", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [{ tool: "github_get_*", allow: true }],
			},
		});

		// github_get_repo matches the glob
		const result = await ctx.client.callTool({ name: "github_get_repo", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: '{"name": "mcp-guard"}' }]);

		// github_create_issue does NOT match the glob — blocked by default deny
		await expect(
			ctx.client.callTool({ name: "github_create_issue", arguments: {} }),
		).rejects.toThrow(/denied/i);
	});

	it("returns an error for unknown tools", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
		});

		await expect(ctx.client.callTool({ name: "nonexistent_tool", arguments: {} })).rejects.toThrow(
			/unknown/i,
		);
	});

	it("lists all tools from the upstream server", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
		});

		const { tools } = await ctx.client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"github_create_issue",
			"github_get_repo",
			"read_file",
			"search_files",
			"write_file",
		]);
	});

	it("first matching rule wins (allow before deny)", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [
					{ tool: "write_file", allow: true },
					{ tool: "write_file", allow: false },
				],
			},
		});

		// First rule is allow — should succeed
		const result = await ctx.client.callTool({ name: "write_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "written" }]);
	});

	it("first matching rule wins (deny before allow)", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "allow",
				rules: [
					{ tool: "write_file", allow: false },
					{ tool: "write_file", allow: true },
				],
			},
		});

		// First rule is deny — should be blocked
		await expect(ctx.client.callTool({ name: "write_file", arguments: {} })).rejects.toThrow(
			/denied/i,
		);
	});
});
