/**
 * Base application error with structured metadata.
 * All application errors must extend this class.
 */
export class AppError extends Error {
	public readonly code: string;
	public readonly retryable: boolean;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		code: string,
		options?: {
			retryable?: boolean;
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = this.constructor.name;
		this.code = code;
		this.retryable = options?.retryable ?? false;
		this.context = options?.context;
	}
}

/** Invalid input, config, or schema. Not retryable. */
export class ValidationError extends AppError {
	constructor(message: string, options?: { context?: Record<string, unknown>; cause?: unknown }) {
		super(message, "VALIDATION_ERROR", {
			retryable: false,
			context: options?.context,
			cause: options?.cause,
		});
	}
}

/** Policy evaluation failure. Not retryable. */
export class PolicyError extends AppError {
	constructor(message: string, options?: { context?: Record<string, unknown>; cause?: unknown }) {
		super(message, "POLICY_ERROR", {
			retryable: false,
			context: options?.context,
			cause: options?.cause,
		});
	}
}

/** Transport or upstream connection failure. Retryable for transient errors. */
export class NetworkError extends AppError {
	constructor(
		message: string,
		options?: {
			retryable?: boolean;
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, "NETWORK_ERROR", {
			retryable: options?.retryable ?? true,
			context: options?.context,
			cause: options?.cause,
		});
	}
}

/** Audit write failure. Retryable for transient errors. */
export class AuditError extends AppError {
	constructor(
		message: string,
		options?: {
			retryable?: boolean;
			context?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message, "AUDIT_ERROR", {
			retryable: options?.retryable ?? true,
			context: options?.context,
			cause: options?.cause,
		});
	}
}

/**
 * Narrows an unknown caught value to an Error.
 * Use in catch blocks: `catch (err: unknown) { const error = toError(err); }`
 */
export function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	return new Error(String(value));
}

/**
 * Maps an unknown error to an AppError with context.
 * Use at boundaries when catching SDK/external errors.
 */
export function toAppError(
	value: unknown,
	operation: string,
	context?: Record<string, unknown>,
): AppError {
	const error = toError(value);
	if (error instanceof AppError) return error;

	return new AppError(`${operation} failed: ${error.message}`, "UNKNOWN_ERROR", {
		retryable: false,
		context,
		cause: error,
	});
}
