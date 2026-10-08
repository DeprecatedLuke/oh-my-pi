/**
 * Background Jobs panel contract: `renderBackgroundJobsLines` row shape
 * (blank + counted header, type/agent tags, age formatting, width clamp) and
 * `BackgroundJobsView` click routing (wrapped rows keep their owner; blank,
 * title, and shell rows map to nothing). The mode-level refresh lifecycle is
 * covered end to end in `interactive-click-focus.test.ts`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	type BackgroundJobRow,
	BackgroundJobsView,
	renderBackgroundJobsLines,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

const AGENT_ID = "Lead.Helper";
const NO_SETTLED = { completed: 0, failed: 0, cancelled: 0 };

function rows(summary = "patching the auth handler"): BackgroundJobRow[] {
	return [
		{ type: "task", agentType: "research", agentId: AGENT_ID, id: AGENT_ID, summary, ageMs: 83_000 },
		{ type: "bash", id: "", summary: "pnpm\ttest", ageMs: 5_000 },
	];
}

beforeAll(async () => {
	await initTheme();
});

describe("renderBackgroundJobsLines", () => {
	it("renders a counted header and one tagged row per running job", () => {
		const lines = renderBackgroundJobsLines(
			[...rows(), { type: "task", id: "Worker", summary: "", ageMs: 1_000 }],
			{ completed: 2, failed: 0, cancelled: 1 },
			120,
		).map(line => Bun.stripANSI(line));
		expect(lines).toEqual([
			"",
			"Background Jobs (3 running, 2 completed, 1 cancelled):",
			`  [research] ${AGENT_ID}: patching the auth handler - 1m23s`,
			"  [shell] pnpm test - 5.0s",
			"  [task] Worker - 1.0s",
		]);
	});

	it("clears with no running jobs and keeps long rows within the terminal width", () => {
		expect(renderBackgroundJobsLines([], NO_SETTLED, 120)).toEqual([]);
		for (const line of renderBackgroundJobsLines(rows("x".repeat(400)), NO_SETTLED, 80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});

describe("BackgroundJobsView click targets", () => {
	function view(columns: number, summary?: string): BackgroundJobsView {
		const jobs = rows(summary);
		const panel = new BackgroundJobsView(
			renderBackgroundJobsLines(jobs, NO_SETTLED, columns),
			jobs.map(job => job.agentId),
		);
		panel.render(columns);
		return panel;
	}

	it("maps task rows to their agent and blank, title, and shell rows to nothing", () => {
		const panel = view(120);
		expect([0, 1, 2, 3, 4].map(row => panel.getClickAgentAtRow(row))).toEqual([
			undefined,
			undefined,
			AGENT_ID,
			undefined,
			undefined,
		]);
	});

	it("keeps wrapped continuation rows with their agent and remaps after a resize", () => {
		const panel = view(48, "x".repeat(300));
		const shellRow = panel
			.render(48)
			.map(row => Bun.stripANSI(row))
			.findIndex(row => row.includes("[shell]"));
		expect(shellRow).toBeGreaterThan(3);
		for (let row = 2; row < shellRow; row++) expect(panel.getClickAgentAtRow(row)).toBe(AGENT_ID);
		expect(panel.getClickAgentAtRow(shellRow)).toBeUndefined();

		expect(panel.render(400)).toHaveLength(4);
		expect(panel.getClickAgentAtRow(2)).toBe(AGENT_ID);
		expect(panel.getClickAgentAtRow(3)).toBeUndefined();
	});
});
