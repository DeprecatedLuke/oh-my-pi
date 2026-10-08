import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
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

	it("fits every row inside the padded view, so no row wraps at any width", () => {
		expect(renderBackgroundJobsLines([], NO_SETTLED, 120)).toEqual([]);
		const jobs: BackgroundJobRow[] = [
			...rows("x".repeat(400)),
			{ type: "task", agentType: "a".repeat(60), id: "Very.Long.Nested.Agent.Id", summary: "s", ageMs: 1 },
		];
		for (const columns of [24, 80, 120]) {
			const lines = renderBackgroundJobsLines(jobs, { completed: 12, failed: 3, cancelled: 4 }, columns);
			expect(new BackgroundJobsView(lines, []).render(columns)).toHaveLength(lines.length);
		}
	});

	it("strips terminal control sequences and shortens home paths in model-written text", () => {
		const lines = renderBackgroundJobsLines(
			[{ type: "bash", id: "", summary: `\x1b[2J\x1b]8;;http://x\x07cat ${os.homedir()}/proj/a.ts`, ageMs: 0 }],
			NO_SETTLED,
			120,
		);
		expect(lines[2]).not.toContain("\x1b[2J");
		expect(lines[2]).not.toContain("\x1b]8");
		expect(Bun.stripANSI(lines[2]!)).toContain("cat ~/proj/a.ts");
	});
});

describe("BackgroundJobsView click targets", () => {
	function view(columns: number, summary?: string, buildColumns = columns): BackgroundJobsView {
		const jobs = rows(summary);
		const panel = new BackgroundJobsView(
			renderBackgroundJobsLines(jobs, NO_SETTLED, buildColumns),
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
		// Rows built for a wide terminal wrap once the terminal narrows before the next repaint.
		const panel = view(48, "x".repeat(300), 400);
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
