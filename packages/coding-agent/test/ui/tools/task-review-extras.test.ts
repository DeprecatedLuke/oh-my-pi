import { describe, expect, it } from "bun:test";
import type { AgentProgress, SingleResult } from "../../../src/task/task-details";
import { type Line, type RowContext, progressRows, resultRows } from "../../../src/ui/tools/task/rows";
import { registerSubprocessToolView } from "../../../src/ui/tools/task/subprocess-views";

/**
 * A review verdict draws its own block and ends the task card, so data other
 * extension-registered tools extracted next to it (issue-tracker entries a
 * reviewer filed) must still be appended below the verdict.
 */
registerSubprocessToolView<{ title: string }>("issue_tracker_case", {
	inline: data => [{ s: "dim", t: `filed ${data.title}` }],
	final: all => all.map(data => `issue ${data.title}`).join("\n"),
});

const cx: RowContext = { glyph: key => key, expandKey: () => "ctrl+o", expanded: false, nowMs: 0, frozen: false };

const verdict = { overall_correctness: "correct", explanation: "Nothing blocking", confidence: 0.9 };

function text(lines: readonly Line[]): string {
	return lines.map(line => line.map(seg => seg.t).join("")).join("\n");
}

function reviewerResult(extracted: Record<string, unknown[]>): SingleResult {
	return {
		index: 0,
		id: "Review",
		agent: "reviewer",
		agentSource: "bundled",
		task: "review the diff",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1200,
		requests: 1,
		extractedToolData: { yield: [{ data: verdict, status: "success" }], ...extracted },
	} as unknown as SingleResult;
}

describe("task card review verdict extras", () => {
	it("keeps another tool's final view below a settled review verdict", () => {
		const rendered = text(
			resultRows(cx, reviewerResult({ issue_tracker_case: [{ title: "Null deref" }] }), [], [], 100),
		);

		expect(rendered).toContain("Nothing blocking");
		expect(rendered).toContain("Tool: issue_tracker_case");
		expect(rendered).toContain("issue Null deref");
		expect(rendered.indexOf("issue Null deref")).toBeGreaterThan(rendered.indexOf("Nothing blocking"));
	});

	it("adds nothing for tools without a final view or without data", () => {
		const rendered = text(
			resultRows(cx, reviewerResult({ unregistered_case: [{ x: 1 }], issue_tracker_case: [] }), [], [], 100),
		);

		expect(rendered).toContain("Nothing blocking");
		expect(rendered).not.toContain("Tool:");
	});

	it("keeps the extras under a completed agent's live progress card too", () => {
		const progress = {
			index: 0,
			id: "Review",
			agent: "reviewer",
			agentSource: "bundled",
			status: "completed",
			task: "review the diff",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 1200,
			extractedToolData: {
				yield: [{ data: verdict, status: "success" }],
				issue_tracker_case: [{ title: "Race on exit" }],
			},
		} as unknown as AgentProgress;

		const rendered = text(progressRows(cx, progress, [], [], 100));

		expect(rendered).toContain("Nothing blocking");
		expect(rendered).toContain("issue Race on exit");
	});
});
