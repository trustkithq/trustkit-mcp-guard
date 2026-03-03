import { afterEach, describe, expect, it } from "vitest";
import type { E2EContext } from "./helpers.js";
import { buildConfig, setupProxy, startProxy, writeTempConfig } from "./helpers.js";

describe("E2E: Edge cases and error handling", () => {
	let ctx: E2EContext;

	afterEach(async () => {
		await ctx?.cleanup();
	});

	it("disables audit persistence when dbPath is false", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
			audit: { dbPath: false },
		});

		// Proxy should work fine without persistence
		const result = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "file contents here" }]);
	});

	it("handles empty rules array with default allow", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
		});

		// All tools from mock should be callable
		const result = await ctx.client.callTool({ name: "write_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "written" }]);
	});

	it("handles empty rules array with default deny", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "deny", rules: [] },
		});

		// All tools should be denied
		await expect(ctx.client.callTool({ name: "read_file", arguments: {} })).rejects.toThrow(
			/denied/i,
		);
	});

	it("handles wildcard * rule that matches everything", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [{ tool: "*", allow: true }],
			},
		});

		// Everything should be allowed
		const result = await ctx.client.callTool({ name: "write_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "written" }]);
	});

	it("rejects invalid config (missing servers)", async () => {
		const yaml = `version: 1
listen:
  transport: stdio
servers: []
policy:
  defaultAction: deny
  rules: []
audit:
  dbPath: false
logLevel: warn
`;

		const configPath = writeTempConfig(yaml);
		await expect(startProxy(configPath)).rejects.toThrow();
	});

	it("proxy returns tool descriptions via tools/list", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
		});

		const { tools } = await ctx.client.listTools();
		const readFile = tools.find((t) => t.name === "read_file");
		expect(readFile).toBeDefined();
		expect(readFile?.description).toBe("Read a file from disk");
	});

	it("supports calling multiple tools in sequence", async () => {
		ctx = await setupProxy({
			policy: { defaultAction: "allow", rules: [] },
		});

		const r1 = await ctx.client.callTool({ name: "read_file", arguments: {} });
		const r2 = await ctx.client.callTool({ name: "search_files", arguments: {} });
		const r3 = await ctx.client.callTool({ name: "github_get_repo", arguments: {} });

		expect(r1.content).toEqual([{ type: "text", text: "file contents here" }]);
		expect(r2.content).toEqual([{ type: "text", text: "found 3 results" }]);
		expect(r3.content).toEqual([{ type: "text", text: '{"name": "mcp-guard"}' }]);
	});

	it("allows a mix of allowed and denied calls in the same session", async () => {
		ctx = await setupProxy({
			policy: {
				defaultAction: "deny",
				rules: [{ tool: "read_file", allow: true }],
			},
		});

		// First call allowed
		const result = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "file contents here" }]);

		// Second call denied
		await expect(ctx.client.callTool({ name: "write_file", arguments: {} })).rejects.toThrow(
			/denied/i,
		);

		// Third call allowed again (proxy still operational after denial)
		const result2 = await ctx.client.callTool({ name: "read_file", arguments: {} });
		expect(result2.content).toEqual([{ type: "text", text: "file contents here" }]);
	});
});
