import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import { ValidationError } from "../errors/base.js";

function writeTempConfig(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	const path = join(dir, "guard.yaml");
	writeFileSync(path, content, "utf-8");
	return path;
}

const validYaml = `
version: 1
servers:
  - name: fs
    transport: stdio
    command: npx
    args: ["-y", "mcp-fs"]
policy:
  defaultAction: deny
  rules:
    - tool: "read_*"
      allow: true
`;

describe("loadConfig", () => {
	it("loads and validates a valid YAML config", () => {
		const path = writeTempConfig(validYaml);
		const config = loadConfig(path);

		expect(config.version).toBe(1);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].name).toBe("fs");
		expect(config.policy.defaultAction).toBe("deny");
		expect(config.policy.rules).toHaveLength(1);
		expect(config.listen.transport).toBe("stdio");
	});

	it("throws ValidationError for nonexistent file", () => {
		expect(() => loadConfig("/nonexistent/guard.yaml")).toThrow(ValidationError);
		try {
			loadConfig("/nonexistent/guard.yaml");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).code).toBe("VALIDATION_ERROR");
			expect((error as ValidationError).message).toContain("Cannot read config file");
		}
	});

	it("throws ValidationError for invalid YAML", () => {
		const path = writeTempConfig("{{{{invalid yaml!!!!");
		expect(() => loadConfig(path)).toThrow(ValidationError);
		try {
			loadConfig(path);
		} catch (error) {
			expect((error as ValidationError).message).toContain("Invalid YAML");
		}
	});

	it("throws ValidationError for valid YAML but invalid schema", () => {
		const path = writeTempConfig("version: 99\nservers: []\n");
		expect(() => loadConfig(path)).toThrow(ValidationError);
		try {
			loadConfig(path);
		} catch (error) {
			expect((error as ValidationError).message).toContain("Config validation failed");
		}
	});

	it("throws ValidationError with issue details for schema errors", () => {
		const path = writeTempConfig("version: 1\npolicy:\n  rules: []\n");
		try {
			loadConfig(path);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain("servers");
		}
	});

	it("preserves cause in validation errors", () => {
		const path = writeTempConfig("{{{{bad");
		try {
			loadConfig(path);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).cause).toBeDefined();
		}
	});
});
