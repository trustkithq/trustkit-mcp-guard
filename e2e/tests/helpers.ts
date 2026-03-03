import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const MOCK_SERVER = resolve(PROJECT_ROOT, "e2e/mock-server/index.ts");
const TSX_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/tsx");

export interface E2EContext {
	client: Client;
	transport: StdioClientTransport;
	configPath: string;
	cleanup: () => Promise<void>;
}

/** Build a guard YAML config pointing to mock server(s). */
export function buildConfig(options: {
	servers?: Array<{
		name: string;
		mockConfig?: string;
	}>;
	policy?: {
		defaultAction?: "allow" | "deny";
		rules?: Array<{ tool: string; allow: boolean }>;
	};
	audit?: { dbPath: string | false };
}): string {
	const servers = options.servers ?? [{ name: "mock" }];
	const policy = options.policy ?? { defaultAction: "deny", rules: [] };

	const serverEntries = servers
		.map((s) => {
			const mockConfigPath = s.mockConfig
				? resolve(PROJECT_ROOT, s.mockConfig)
				: resolve(PROJECT_ROOT, "e2e/configs/mock-tools.json");
			return `  - name: ${s.name}
    transport: stdio
    command: "${TSX_BIN}"
    args: ["${MOCK_SERVER}", "--config", "${mockConfigPath}"]`;
		})
		.join("\n");

	const ruleEntries = (policy.rules ?? [])
		.map((r) => `    - tool: "${r.tool}"\n      allow: ${r.allow}`)
		.join("\n");

	return `version: 1
listen:
  transport: stdio
servers:
${serverEntries}
policy:
  defaultAction: ${policy.defaultAction ?? "deny"}
  rules:
${ruleEntries || "    []"}
audit:
  dbPath: ${options.audit?.dbPath === false ? "false" : `"${options.audit?.dbPath ?? ":memory:"}"`}
logLevel: warn
`;
}

/** Write a config to a temp file and return its path. */
export function writeTempConfig(yamlContent: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-guard-e2e-"));
	const path = join(dir, "guard.yaml");
	writeFileSync(path, yamlContent, "utf-8");
	return path;
}

/** Start the proxy and connect a Client to it. */
export async function startProxy(configPath: string): Promise<E2EContext> {
	const transport = new StdioClientTransport({
		command: TSX_BIN,
		args: [resolve(PROJECT_ROOT, "src/cli.ts"), "--config", configPath],
		stderr: "pipe",
	});

	const client = new Client({ name: "e2e-test-client", version: "0.1.0" });
	await client.connect(transport);

	const cleanup = async (): Promise<void> => {
		await client.close();
	};

	return { client, transport, configPath, cleanup };
}

/** Convenience: build config, write it, start proxy, return context. */
export async function setupProxy(options: Parameters<typeof buildConfig>[0]): Promise<E2EContext> {
	const yaml = buildConfig(options);
	const configPath = writeTempConfig(yaml);
	return startProxy(configPath);
}
