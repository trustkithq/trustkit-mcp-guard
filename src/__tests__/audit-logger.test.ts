import { describe, expect, it } from "vitest";
import { AuditLogger } from "../audit/logger.js";
import { createLogger } from "../logger/index.js";

const logger = createLogger({ level: "silent" });

describe("AuditLogger", () => {
	it("records an audit event with timestamp", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "read_file", allowed: true, reason: "Allowed by rule: read_*" });

		const events = audit.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0].tool).toBe("read_file");
		expect(events[0].allowed).toBe(true);
		expect(events[0].reason).toBe("Allowed by rule: read_*");
		expect(events[0].timestamp).toBeDefined();
		// Verify ISO 8601 format
		expect(new Date(events[0].timestamp).toISOString()).toBe(events[0].timestamp);
	});

	it("records denied events", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "write_file", allowed: false, reason: "Denied by rule: write_*" });

		const events = audit.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0].allowed).toBe(false);
	});

	it("preserves requestId and upstreamName", () => {
		const audit = new AuditLogger(logger);

		audit.log({
			tool: "read_file",
			allowed: true,
			reason: "Allowed",
			requestId: 42,
			upstreamName: "fs-server",
		});

		const events = audit.getEvents();
		expect(events[0].requestId).toBe(42);
		expect(events[0].upstreamName).toBe("fs-server");
	});

	it("accumulates multiple events", () => {
		const audit = new AuditLogger(logger);

		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });
		audit.log({ tool: "write_file", allowed: false, reason: "denied" });
		audit.log({ tool: "search", allowed: true, reason: "allowed" });

		expect(audit.getEvents()).toHaveLength(3);
	});

	it("returns readonly events array", () => {
		const audit = new AuditLogger(logger);
		audit.log({ tool: "read_file", allowed: true, reason: "allowed" });

		const events = audit.getEvents();
		// TypeScript enforces readonly, but verify it returns the right data
		expect(events[0].tool).toBe("read_file");
	});
});
