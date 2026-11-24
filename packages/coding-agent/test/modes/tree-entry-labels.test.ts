import { describe, expect, it } from "bun:test";
import { formatToolCall } from "../../src/modes/view-model/overlays/tree-entry-labels";

describe("formatToolCall", () => {
	it("labels the legacy `search` tool name like its `grep` alias", () => {
		const args = { pattern: "needle", paths: ["src", "test"] };

		expect(formatToolCall("search", args)).toBe("[grep: /needle/ in src, test]");
		expect(formatToolCall("search", args)).toBe(formatToolCall("grep", args));
	});
});
