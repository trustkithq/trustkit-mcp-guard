import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { ValidationError } from "../errors/base.js";
import { type GuardConfig, guardConfigSchema } from "./schema.js";

/**
 * Loads and validates a guard config from a YAML file.
 * Throws ValidationError on parse or schema validation failure.
 */
export function loadConfig(filePath: string): GuardConfig {
	const absolutePath = resolve(filePath);

	const raw = readConfigFile(absolutePath);
	const parsed = parseYaml(raw, absolutePath);
	return validateConfig(parsed, absolutePath);
}

function readConfigFile(absolutePath: string): string {
	try {
		return readFileSync(absolutePath, "utf-8");
	} catch (error: unknown) {
		throw new ValidationError(`Cannot read config file: ${absolutePath}`, {
			context: { path: absolutePath },
			cause: error,
		});
	}
}

function parseYaml(raw: string, absolutePath: string): unknown {
	try {
		return parse(raw);
	} catch (error: unknown) {
		throw new ValidationError(`Invalid YAML in config file: ${absolutePath}`, {
			context: { path: absolutePath },
			cause: error,
		});
	}
}

function validateConfig(data: unknown, absolutePath: string): GuardConfig {
	try {
		return guardConfigSchema.parse(data);
	} catch (error: unknown) {
		if (error instanceof ZodError) {
			const issues = error.issues
				.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
				.join("\n");

			throw new ValidationError(`Config validation failed:\n${issues}`, {
				context: { path: absolutePath },
				cause: error,
			});
		}
		throw new ValidationError(`Config validation failed: ${absolutePath}`, {
			context: { path: absolutePath },
			cause: error,
		});
	}
}
