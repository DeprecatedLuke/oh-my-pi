import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/render";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

// The reviewer agent files findings through the `issues` tool (`op: add`), not
// `report_finding`. The subprocess registry captures each add into
// `extractedToolData.issues`, but the review-result renderer used to forward
// only `extractedToolData.report_finding` to the verdict block and `return`
// before the generic tool loop — so a verdict backed by N filed issues rendered
// as "Findings: none" with the catalogue invisible. These tests lock the
// contract that filed issues are surfaced alongside the verdict.
describe("task renderer: review verdict surfaces filed issues", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const resolved = await getThemeByName("dark");
		expect(resolved).toBeDefined();
		theme = resolved!;
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	const verdict = {
		yield: [
			{
				data: {
					overall_correctness: "incorrect",
					explanation: "Found a guest-triggerable use-after-free.",
					confidence: 0.85,
				},
			},
		],
	};

	function makeResult(extractedToolData: Record<string, unknown[]>): SingleResult {
		return {
			index: 0,
			id: "GpuEscapeAudit",
			agent: "reviewer",
			agentSource: "bundled",
			task: "Audit the virglrenderer fence path",
			assignment: "Audit the virglrenderer fence path",
			description: "GPU escape audit",
			exitCode: 0,
			output: "Review complete.",
			stderr: "",
			truncated: false,
			durationMs: 1234,
			tokens: 100,
			requests: 5,
			extractedToolData,
		};
	}

	function render(result: SingleResult, expanded = false): string {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: result.durationMs,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: false },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("lists issues filed via the issues tool instead of reporting Findings: none", () => {
		const out = render(
			makeResult({
				...verdict,
				issues: [
					{
						op: "add",
						id: 7,
						title: "Use-after-free in vrend fence path",
						severity: "critical",
						url: "issues://7-uaf.md",
						category: "security",
						filename: "7-uaf.md",
					},
					{
						op: "add",
						id: 8,
						title: "Missing bounds check on guest length",
						severity: "high",
						url: "issues://8-bounds.md",
						category: "security",
						filename: "8-bounds.md",
					},
				],
			}),
		);

		// Verdict still renders.
		expect(out).toContain("Patch is");
		expect(out).toContain("incorrect");
		// The filed catalogue is surfaced rather than collapsing to "none".
		expect(out).not.toContain("Findings: none");
		expect(out).toContain("Use-after-free in vrend fence path");
		expect(out).toContain("Missing bounds check on guest length");
		expect(out).toContain("[critical]");
		expect(out).toContain("[high]");
		expect(out).toContain("issues://7-uaf.md");
		// Severity breakdown reflects the filed adds.
		expect(out).toContain("critical:1");
		expect(out).toContain("high:1");
	});

	it("still reports Findings: none when a verdict is backed by nothing filed", () => {
		const out = render(makeResult({ ...verdict }));
		expect(out).toContain("Patch is");
		expect(out).toContain("Findings: none");
	});

	it("counts only new adds, ignoring dedup edits of existing issues", () => {
		const out = render(
			makeResult({
				...verdict,
				issues: [
					{
						op: "add",
						id: 9,
						title: "Real new finding",
						severity: "medium",
						url: "issues://9.md",
						filename: "9.md",
					},
					// A non-`add` op (e.g. an archive shortcut) is not a new finding — the
					// review renderer counts and lists only `add` entries.
					{ op: "archive", id: 3, title: "Pre-existing open issue restated", severity: "high" },
				],
			}),
		);

		expect(out).not.toContain("Findings: none");
		expect(out).toContain("Real new finding");
		expect(out).not.toContain("Pre-existing open issue restated");
		expect(out).toContain("medium:1");
	});
});
