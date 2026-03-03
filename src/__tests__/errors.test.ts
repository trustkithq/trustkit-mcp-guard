import { describe, expect, it } from "vitest";
import {
	AppError,
	AuditError,
	NetworkError,
	PolicyError,
	ValidationError,
	toAppError,
	toError,
} from "../errors/base.js";

describe("AppError", () => {
	it("creates error with code and message", () => {
		const error = new AppError("something failed", "TEST_ERROR");
		expect(error.message).toBe("something failed");
		expect(error.code).toBe("TEST_ERROR");
		expect(error.retryable).toBe(false);
		expect(error.name).toBe("AppError");
		expect(error).toBeInstanceOf(Error);
	});

	it("preserves cause", () => {
		const cause = new Error("root cause");
		const error = new AppError("wrapped", "TEST_ERROR", { cause });
		expect(error.cause).toBe(cause);
	});

	it("attaches context", () => {
		const error = new AppError("fail", "TEST_ERROR", {
			context: { tool: "read_file", server: "fs" },
		});
		expect(error.context).toEqual({ tool: "read_file", server: "fs" });
	});
});

describe("ValidationError", () => {
	it("has correct code and is not retryable", () => {
		const error = new ValidationError("bad config");
		expect(error.code).toBe("VALIDATION_ERROR");
		expect(error.retryable).toBe(false);
		expect(error.name).toBe("ValidationError");
		expect(error).toBeInstanceOf(AppError);
	});
});

describe("PolicyError", () => {
	it("has correct code and is not retryable", () => {
		const error = new PolicyError("denied");
		expect(error.code).toBe("POLICY_ERROR");
		expect(error.retryable).toBe(false);
		expect(error.name).toBe("PolicyError");
	});
});

describe("NetworkError", () => {
	it("is retryable by default", () => {
		const error = new NetworkError("connection refused");
		expect(error.code).toBe("NETWORK_ERROR");
		expect(error.retryable).toBe(true);
	});

	it("can be marked non-retryable", () => {
		const error = new NetworkError("auth failed", { retryable: false });
		expect(error.retryable).toBe(false);
	});
});

describe("AuditError", () => {
	it("is retryable by default", () => {
		const error = new AuditError("write failed");
		expect(error.code).toBe("AUDIT_ERROR");
		expect(error.retryable).toBe(true);
	});
});

describe("toError", () => {
	it("passes through Error instances", () => {
		const err = new Error("test");
		expect(toError(err)).toBe(err);
	});

	it("wraps strings", () => {
		const err = toError("something broke");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("something broke");
	});

	it("wraps other types", () => {
		expect(toError(42).message).toBe("42");
		expect(toError(null).message).toBe("null");
		expect(toError(undefined).message).toBe("undefined");
	});
});

describe("toAppError", () => {
	it("passes through AppError instances", () => {
		const original = new ValidationError("bad");
		const result = toAppError(original, "test");
		expect(result).toBe(original);
	});

	it("wraps regular Error with context", () => {
		const original = new Error("timeout");
		const result = toAppError(original, "upstream.call", { server: "fs" });
		expect(result).toBeInstanceOf(AppError);
		expect(result.code).toBe("UNKNOWN_ERROR");
		expect(result.message).toBe("upstream.call failed: timeout");
		expect(result.context).toEqual({ server: "fs" });
		expect(result.cause).toBe(original);
	});

	it("wraps non-Error values", () => {
		const result = toAppError("crash", "test");
		expect(result).toBeInstanceOf(AppError);
		expect(result.message).toContain("crash");
	});
});
