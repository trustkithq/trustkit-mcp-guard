import pino from "pino";
import type { AppError } from "../errors/base.js";

/**
 * Logger interface — abstracts the underlying implementation.
 * All application code should use this interface, not pino directly.
 */
export interface Logger {
	debug(context: Record<string, unknown>, message: string): void;
	info(context: Record<string, unknown>, message: string): void;
	warn(context: Record<string, unknown>, message: string): void;
	error(context: Record<string, unknown>, message: string): void;
	/** Create a child logger with bound context (e.g. requestId). */
	child(bindings: Record<string, unknown>): Logger;
}

/**
 * Formats an AppError for structured logging.
 * Extracts code, context, and cause without leaking secrets.
 */
export function formatError(error: AppError): Record<string, unknown> {
	const result: Record<string, unknown> = {
		errorCode: error.code,
		message: error.message,
		retryable: error.retryable,
	};
	if (error.context) {
		result.context = error.context;
	}
	if (error.cause instanceof Error) {
		result.cause = error.cause.message;
	}
	return result;
}

function wrapPino(instance: pino.Logger): Logger {
	return {
		debug(context, message) {
			instance.debug(context, message);
		},
		info(context, message) {
			instance.info(context, message);
		},
		warn(context, message) {
			instance.warn(context, message);
		},
		error(context, message) {
			instance.error(context, message);
		},
		child(bindings) {
			return wrapPino(instance.child(bindings));
		},
	};
}

/**
 * Creates the application logger.
 * Outputs structured JSON to stderr (stdout is reserved for MCP JSON-RPC).
 */
export function createLogger(options?: { level?: string }): Logger {
	const level = options?.level ?? process.env.LOG_LEVEL ?? "info";

	const instance = pino(
		{
			level,
			transport: undefined,
			timestamp: pino.stdTimeFunctions.isoTime,
			// Write to stderr — stdout is the MCP JSON-RPC channel
		},
		pino.destination({ dest: 2, sync: false }),
	);

	return wrapPino(instance);
}
