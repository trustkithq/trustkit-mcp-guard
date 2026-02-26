import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../policy/engine.js";
import type { PolicyConfig } from "../policy/schema.js";

const config: PolicyConfig = {
	version: 1,
	defaultAction: "deny",
	rules: [
		{ tool: "read_file", allow: true },
		{ tool: "github_*", allow: true },
		{ tool: "write_file", allow: false },
	],
};

describe("PolicyEngine", () => {
	const engine = new PolicyEngine(config);

	it("allows an explicitly permitted tool", () => {
		const result = engine.evaluate("read_file");
		expect(result.allowed).toBe(true);
		expect(result.matchedRule?.tool).toBe("read_file");
	});

	it("allows a tool matching a glob pattern", () => {
		const result = engine.evaluate("github_get_repo");
		expect(result.allowed).toBe(true);
		expect(result.matchedRule?.tool).toBe("github_*");
	});

	it("denies an explicitly blocked tool", () => {
		const result = engine.evaluate("write_file");
		expect(result.allowed).toBe(false);
	});

	it("falls back to defaultAction for unmatched tools", () => {
		const result = engine.evaluate("unknown_tool");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("default action");
	});

	it("allows unmatched tools when defaultAction is allow", () => {
		const permissive = new PolicyEngine({
			version: 1,
			defaultAction: "allow",
			rules: [{ tool: "dangerous_tool", allow: false }],
		});
		expect(permissive.evaluate("some_tool").allowed).toBe(true);
		expect(permissive.evaluate("dangerous_tool").allowed).toBe(false);
	});
});
