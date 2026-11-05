import { describe, expect, it } from "vitest";
import { findTransform, transformResult } from "../proxy/transform.js";

const dataset = {
	data: {
		rows: [["a", 1]],
		cols: [{ name: "x", "lib/source": "source/native", field_ref: ["field", "x"] }],
		results_metadata: { columns: [{ fingerprint: { avg: 1 } }] },
	},
	json_query: { native: "select 1" },
	row_count: 1,
};

function textResult(text: string) {
	return { content: [{ type: "text", text }] };
}

describe("findTransform", () => {
	const transforms = [
		{ tools: ["execute_*"], compactJson: true, omitKeys: [] },
		{ tools: ["*"], compactJson: false, omitKeys: ["secret"] },
	];

	it("returns the first transform whose tools match", () => {
		expect(findTransform(transforms, "execute_query")).toBe(transforms[0]);
		expect(findTransform(transforms, "list_cards")).toBe(transforms[1]);
	});

	it("returns undefined when nothing matches", () => {
		expect(findTransform([transforms[0]], "list_cards")).toBeUndefined();
	});
});

describe("transformResult", () => {
	it("drops omitted keys at any depth, including trailing-* globs", () => {
		const result = transformResult(textResult(JSON.stringify(dataset)), {
			tools: ["*"],
			compactJson: true,
			omitKeys: ["results_metadata", "json_query", "field_ref", "lib/*"],
		});

		expect(JSON.parse(result.content[0].text)).toEqual({
			data: { rows: [["a", 1]], cols: [{ name: "x" }] },
			row_count: 1,
		});
	});

	it("compacts JSON only when asked", () => {
		const pretty = JSON.stringify(dataset, null, 2);
		const compact = transformResult(textResult(pretty), {
			tools: ["*"],
			compactJson: true,
			omitKeys: [],
		});
		const indented = transformResult(textResult(pretty), {
			tools: ["*"],
			compactJson: false,
			omitKeys: [],
		});

		expect(compact.content[0].text).toBe(JSON.stringify(dataset));
		expect(indented.content[0].text).toBe(pretty);
	});

	it("passes non-JSON text and non-text content through unchanged", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const result = transformResult(
			{ content: [{ type: "text", text: "not json {" }, image], isError: false },
			{ tools: ["*"], compactJson: true, omitKeys: ["data"] },
		);

		expect(result.content[0]).toEqual({ type: "text", text: "not json {" });
		expect(result.content[1]).toBe(image);
		expect(result.isError).toBe(false);
	});
});
