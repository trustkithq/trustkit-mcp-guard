import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTempConfig } from "./helpers.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const MOCK_SERVER = resolve(PROJECT_ROOT, "e2e/mock-server/index.ts");
const MOCK_CONFIG = resolve(PROJECT_ROOT, "e2e/configs/mock-tools.json");
const TSX_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/tsx");

const ACCEPT = "application/json, text/event-stream";

interface HttpGuard {
	url: string;
	process: ChildProcess;
}

/** Start the guard with the HTTP transport on a random port and wait for /health. */
async function startHttpGuard(listen: {
	sessionIdleTimeoutMs?: number;
	maxSessions?: number;
}): Promise<HttpGuard> {
	const port = 40000 + Math.floor(Math.random() * 20000);
	const extra = Object.entries(listen)
		.map(([key, value]) => `  ${key}: ${value}`)
		.join("\n");
	const configPath = writeTempConfig(`version: 1
listen:
  transport: http
  host: 127.0.0.1
  port: ${port}
${extra}
servers:
  - name: mock
    transport: stdio
    command: "${TSX_BIN}"
    args: ["${MOCK_SERVER}", "--config", "${MOCK_CONFIG}"]
policy:
  defaultAction: allow
  rules: []
audit:
  dbPath: false
logLevel: warn
`);
	const child = spawn(TSX_BIN, [resolve(PROJECT_ROOT, "src/cli.ts"), "--config", configPath], {
		stdio: "ignore",
	});
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return { url, process: child };
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	child.kill();
	throw new Error("MCP Guard did not start");
}

/** Initialize a stateful session over raw HTTP and return its id. */
async function initSession(url: string): Promise<string> {
	const res = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: ACCEPT },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "e2e", version: "0.0.0" },
			},
		}),
	});
	expect(res.status).toBe(200);
	await res.text();
	const sessionId = res.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();
	return sessionId as string;
}

/** Send tools/list on a session; returns the HTTP status. */
async function listTools(url: string, sessionId: string): Promise<number> {
	const res = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: ACCEPT,
			"Mcp-Session-Id": sessionId,
			"Mcp-Protocol-Version": "2025-03-26",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
	});
	await res.text();
	return res.status;
}

describe("E2E: HTTP session lifecycle", () => {
	let guard: HttpGuard | undefined;

	afterEach(() => {
		guard?.process.kill();
		guard = undefined;
	});

	it("answers an unknown session with 404 so the client re-initializes", async () => {
		guard = await startHttpGuard({});
		const res = await fetch(`${guard.url}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: ACCEPT, "Mcp-Session-Id": "nope" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: -32001 } });
	});

	it("closes a session after it has been idle for sessionIdleTimeoutMs", async () => {
		guard = await startHttpGuard({ sessionIdleTimeoutMs: 500 });
		const sessionId = await initSession(guard.url);
		expect(await listTools(guard.url, sessionId)).toBe(200);

		await new Promise((r) => setTimeout(r, 1500));

		expect(await listTools(guard.url, sessionId)).toBe(404);
	});

	it("keeps a session that stays active", async () => {
		guard = await startHttpGuard({ sessionIdleTimeoutMs: 800 });
		const sessionId = await initSession(guard.url);
		for (let i = 0; i < 4; i++) {
			await new Promise((r) => setTimeout(r, 400));
			expect(await listTools(guard.url, sessionId)).toBe(200);
		}
	});

	it("closes the least recently active session at maxSessions", async () => {
		guard = await startHttpGuard({ maxSessions: 2 });
		const first = await initSession(guard.url);
		const second = await initSession(guard.url);
		expect(await listTools(guard.url, first)).toBe(200);

		const third = await initSession(guard.url);

		expect(await listTools(guard.url, second)).toBe(404);
		expect(await listTools(guard.url, first)).toBe(200);
		expect(await listTools(guard.url, third)).toBe(200);
	});

	it("forgets a session the client deletes", async () => {
		guard = await startHttpGuard({});
		const sessionId = await initSession(guard.url);
		const res = await fetch(`${guard.url}/mcp`, {
			method: "DELETE",
			headers: { "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-03-26" },
		});
		expect(res.status).toBe(200);

		expect(await listTools(guard.url, sessionId)).toBe(404);
	});
});
