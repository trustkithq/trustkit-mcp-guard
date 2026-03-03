import { describe, expect, it } from "vitest";
import { guardConfigSchema } from "../config/schema.js";

const validStdioConfig = {
	version: 1,
	servers: [{ name: "fs", transport: "stdio", command: "npx", args: ["-y", "mcp-fs"] }],
	policy: { defaultAction: "deny", rules: [] },
};

const validHttpConfig = {
	version: 1,
	listen: { transport: "http", port: 8080 },
	servers: [{ name: "remote", transport: "http", url: "http://localhost:4000/mcp" }],
	policy: { defaultAction: "allow", rules: [] },
};

describe("guardConfigSchema", () => {
	describe("valid configs", () => {
		it("parses minimal stdio config with defaults", () => {
			const result = guardConfigSchema.parse(validStdioConfig);

			expect(result.version).toBe(1);
			expect(result.listen.transport).toBe("stdio");
			expect(result.listen.port).toBe(31415);
			expect(result.listen.host).toBe("0.0.0.0");
			expect(result.logLevel).toBe("info");
			expect(result.audit.dbPath).toBe("~/.mcp-guard/guard.db");
			expect(result.audit.retentionHours).toBe(24);
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].name).toBe("fs");
		});

		it("parses custom audit config", () => {
			const config = {
				...validStdioConfig,
				audit: { dbPath: "/tmp/guard.db", retentionHours: 48 },
			};
			const result = guardConfigSchema.parse(config);
			expect(result.audit.dbPath).toBe("/tmp/guard.db");
			expect(result.audit.retentionHours).toBe(48);
		});

		it("allows disabling audit persistence", () => {
			const config = { ...validStdioConfig, audit: { dbPath: false } };
			const result = guardConfigSchema.parse(config);
			expect(result.audit.dbPath).toBe(false);
		});

		it("parses HTTP listen config", () => {
			const result = guardConfigSchema.parse(validHttpConfig);

			expect(result.listen.transport).toBe("http");
			expect(result.listen.port).toBe(8080);
			expect(result.servers[0]).toEqual({
				name: "remote",
				transport: "http",
				url: "http://localhost:4000/mcp",
			});
		});

		it("parses mixed upstream servers", () => {
			const config = {
				version: 1,
				servers: [
					{ name: "local", transport: "stdio", command: "node", args: ["server.js"] },
					{ name: "remote", transport: "http", url: "https://api.example.com/mcp" },
				],
				policy: { defaultAction: "deny", rules: [] },
			};

			const result = guardConfigSchema.parse(config);
			expect(result.servers).toHaveLength(2);
			expect(result.servers[0].transport).toBe("stdio");
			expect(result.servers[1].transport).toBe("http");
		});

		it("parses policy rules with defaults", () => {
			const config = {
				...validStdioConfig,
				policy: {
					defaultAction: "deny",
					rules: [
						{ tool: "read_*", allow: true },
						{ tool: "write_file", allow: false },
						{ tool: "search" },
					],
				},
			};

			const result = guardConfigSchema.parse(config);
			expect(result.policy.rules).toHaveLength(3);
			expect(result.policy.rules[0]).toEqual({ tool: "read_*", allow: true });
			expect(result.policy.rules[2].allow).toBe(true); // default
		});

		it("applies default policy action", () => {
			const config = {
				version: 1,
				servers: [{ name: "fs", transport: "stdio", command: "npx" }],
				policy: { rules: [] },
			};

			const result = guardConfigSchema.parse(config);
			expect(result.policy.defaultAction).toBe("deny");
		});

		it("parses stdio server with env and cwd", () => {
			const config = {
				...validStdioConfig,
				servers: [
					{
						name: "custom",
						transport: "stdio",
						command: "node",
						args: ["server.js"],
						env: { NODE_ENV: "production", API_KEY: "***" },
						cwd: "/opt/mcp-server",
					},
				],
			};

			const result = guardConfigSchema.parse(config);
			const server = result.servers[0];
			expect(server.transport).toBe("stdio");
			if (server.transport === "stdio") {
				expect(server.env).toEqual({ NODE_ENV: "production", API_KEY: "***" });
				expect(server.cwd).toBe("/opt/mcp-server");
			}
		});

		it("applies default args for stdio server", () => {
			const config = {
				version: 1,
				servers: [{ name: "simple", transport: "stdio", command: "mcp-server" }],
				policy: { defaultAction: "deny", rules: [] },
			};

			const result = guardConfigSchema.parse(config);
			if (result.servers[0].transport === "stdio") {
				expect(result.servers[0].args).toEqual([]);
			}
		});
	});

	describe("invalid configs", () => {
		it("rejects missing version", () => {
			const config = { servers: [validStdioConfig.servers[0]], policy: { rules: [] } };
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects wrong version", () => {
			const config = { ...validStdioConfig, version: 2 };
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects empty servers array", () => {
			const config = { ...validStdioConfig, servers: [] };
			expect(() => guardConfigSchema.parse(config)).toThrow(/At least one upstream server/);
		});

		it("rejects missing servers", () => {
			const config = { version: 1, policy: { rules: [] } };
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects stdio server without command", () => {
			const config = {
				...validStdioConfig,
				servers: [{ name: "bad", transport: "stdio" }],
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects http server without url", () => {
			const config = {
				...validStdioConfig,
				servers: [{ name: "bad", transport: "http" }],
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects http server with invalid url", () => {
			const config = {
				...validStdioConfig,
				servers: [{ name: "bad", transport: "http", url: "not-a-url" }],
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects invalid transport type", () => {
			const config = {
				...validStdioConfig,
				servers: [{ name: "bad", transport: "grpc", command: "x" }],
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects invalid defaultAction", () => {
			const config = { ...validStdioConfig, policy: { defaultAction: "maybe", rules: [] } };
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects invalid logLevel", () => {
			const config = { ...validStdioConfig, logLevel: "verbose" };
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects invalid port", () => {
			const config = {
				...validStdioConfig,
				listen: { transport: "http", port: 99999 },
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});

		it("rejects server with empty name", () => {
			const config = {
				...validStdioConfig,
				servers: [{ name: "", transport: "stdio", command: "x" }],
			};
			expect(() => guardConfigSchema.parse(config)).toThrow();
		});
	});
});
