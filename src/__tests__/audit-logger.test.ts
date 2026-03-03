import { describe, expect, it } from "vitest";
import { AuditLogger } from "../audit/logger.js";
import { createLogger } from "../logger/index.js";

const logger = createLogger({ level: "silent" });

describe("AuditLogger", () => {
	it("records an audit event with timestamp and correlationId", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "read_file", allowed: true, reason: "Allowed by rule: read_*" });

		const events = audit.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0].tool).toBe("read_file");
		expect(events[0].allowed).toBe(true);
		expect(events[0].reason).toBe("Allowed by rule: read_*");
		expect(events[0].timestamp).toBeDefined();
		expect(events[0].correlationId).toBe(audit.correlationId);
		// Verify ISO 8601 format
		expect(new Date(events[0].timestamp).toISOString()).toBe(events[0].timestamp);
	});

	it("uses consistent correlationId across events", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });
		audit.log({ tool: "write_file", allowed: false, reason: "denied" });

		const events = audit.getEvents();
		expect(events[0].correlationId).toBe(events[1].correlationId);
		// UUID v4 format
		expect(events[0].correlationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("accepts custom correlationId", () => {
		const audit = new AuditLogger(logger, "custom-id-123");

		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });

		expect(audit.correlationId).toBe("custom-id-123");
		expect(audit.getEvents()[0].correlationId).toBe("custom-id-123");
	});

	it("records denied events", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "write_file", allowed: false, reason: "Denied by rule: write_*" });

		const events = audit.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0].allowed).toBe(false);
	});

	it("preserves requestId, serverName, and durationMs", () => {
		const audit = new AuditLogger(logger);

		audit.log({
			tool: "read_file",
			allowed: true,
			reason: "Allowed",
			requestId: 42,
			serverName: "fs-server",
			durationMs: 150,
		});

		const events = audit.getEvents();
		expect(events[0].requestId).toBe(42);
		expect(events[0].serverName).toBe("fs-server");
		expect(events[0].durationMs).toBe(150);
	});

	it("preserves error field", () => {
		const audit = new AuditLogger(logger);

		audit.log({
			tool: "read_file",
			allowed: true,
			reason: "Allowed",
			error: "Connection timeout",
		});

		expect(audit.getEvents()[0].error).toBe("Connection timeout");
	});

	it("accumulates multiple events", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });
		audit.log({ tool: "write_file", allowed: false, reason: "denied" });
		audit.log({ tool: "search", allowed: true, reason: "allowed" });

		expect(audit.getEvents()).toHaveLength(3);
	});

	it("notifies sinks on each event", () => {
		const audit = new AuditLogger(logger);
		const sinkEvents: unknown[] = [];
		audit.addSink((event) => sinkEvents.push(event));

		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });

		expect(sinkEvents).toHaveLength(1);
		expect((sinkEvents[0] as { tool: string }).tool).toBe("read_file");
	});
});
