import type { ResponseTransform } from "../config/schema.js";
import { matchesGlob } from "../policy/engine.js";

interface ToolResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

/** Returns the first transform whose `tools` patterns match the tool, if any. */
export function findTransform(
	transforms: readonly ResponseTransform[],
	toolName: string,
): ResponseTransform | undefined {
	return transforms.find((t) => t.tools.some((pattern) => matchesGlob(pattern, toolName)));
}

/**
 * Applies a response transform to a tool result. Text items that parse as JSON
 * lose the omitted keys and are re-serialized (compact if requested); all other
 * content, and any text that is not JSON, is returned unchanged.
 */
export function transformResult<T extends ToolResult>(result: T, transform: ResponseTransform): T {
	if (!Array.isArray(result.content)) return result;
	const content = result.content.map((item) => {
		if (item.type !== "text" || typeof item.text !== "string") return item;
		let parsed: unknown;
		try {
			parsed = JSON.parse(item.text);
		} catch {
			return item;
		}
		const pruned = omitKeys(parsed, transform.omitKeys);
		const text = transform.compactJson ? JSON.stringify(pruned) : JSON.stringify(pruned, null, 2);
		return { ...item, text };
	});
	return { ...result, content };
}

function omitKeys(value: unknown, patterns: readonly string[]): unknown {
	if (patterns.length === 0) return value;
	if (Array.isArray(value)) {
		return value.map((v) => omitKeys(v, patterns));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (patterns.some((p) => matchesGlob(p, key))) continue;
			out[key] = omitKeys(v, patterns);
		}
		return out;
	}
	return value;
}
