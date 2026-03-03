import { afterEach, describe, expect, it } from "vitest";
import type { E2EContext } from "./helpers.js";
import { setupProxy } from "./helpers.js";

describe("E2E: Multi-upstream routing", () => {
	let ctx: E2EContext;

	afterEach(async () => {
		await ctx?.cleanup();
	});

	it("aggregates tools from two upstream servers", async () => {
		ctx = await setupProxy({
			servers: [
				{ name: "filesystem", mockConfig: "e2e/configs/mock-tools.json" },
				{ name: "git", mockConfig: "e2e/configs/mock-tools-alt.json" },
			],
			policy: { defaultAction: "allow", rules: [] },
		});

		const { tools } = await ctx.client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"get_diff",
			"github_create_issue",
			"github_get_repo",
			"list_branches",
			"read_file",
			"search_files",
			"write_file",
		]);
	});

	it("routes tool calls to the correct upstream server", async () => {
		ctx = await setupProxy({
			servers: [
				{ name: "filesystem", mockConfig: "e2e/configs/mock-tools.json" },
				{ name: "git", mockConfig: "e2e/configs/mock-tools-alt.json" },
			],
			policy: { defaultAction: "allow", rules: [] },
		});

		// read_file is from the filesystem upstream
		const fileResult = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(fileResult.content).toEqual([{ type: "text", text: "file contents here" }]);

		// list_branches is from the git upstream
		const branchResult = await ctx.client.callTool({ name: "list_branches", arguments: {} });
		expect(branchResult.content).toEqual([{ type: "text", text: "main, develop" }]);
	});

	it("applies policy independently of upstream routing", async () => {
		ctx = await setupProxy({
			servers: [
				{ name: "filesystem", mockConfig: "e2e/configs/mock-tools.json" },
				{ name: "git", mockConfig: "e2e/configs/mock-tools-alt.json" },
			],
			policy: {
				defaultAction: "deny",
				rules: [
					{ tool: "read_file", allow: true },
					{ tool: "list_branches", allow: true },
					{ tool: "write_file", allow: false },
				],
			},
		});

		// Allowed from filesystem upstream
		const readResult = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(readResult.content).toEqual([{ type: "text", text: "file contents here" }]);

		// Allowed from git upstream
		const branchResult = await ctx.client.callTool({ name: "list_branches", arguments: {} });
		expect(branchResult.content).toEqual([{ type: "text", text: "main, develop" }]);

		// Denied by explicit rule (filesystem upstream)
		await expect(ctx.client.callTool({ name: "write_file", arguments: {} })).rejects.toThrow(
			/denied/i,
		);

		// Denied by default deny (git upstream)
		await expect(ctx.client.callTool({ name: "get_diff", arguments: {} })).rejects.toThrow(
			/denied/i,
		);
	});
});
