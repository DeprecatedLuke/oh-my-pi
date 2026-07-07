/**
 * Contract: the anchored "Background Jobs" panel (`renderBackgroundJobsLines`,
 * surfaced via `EventController.refreshBackgroundJobs()`) lists the main
 * session's running async jobs as `[task] Id: summary - age` and `[shell] cmd -
 * age` rows under a `Background Jobs (N running, M completed)` header, renders
 * into the anchored `subagentContainer`, prefers a task's live current action
 * over its spawn label, and is suppressed while observing a subagent
 * (focusedAgentId set), returning on unfocus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type BackgroundJobRow,
	EventController,
	renderBackgroundJobsLines,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	await initTheme();
});

const NO_SETTLED = { completed: 0, failed: 0, cancelled: 0 };

interface Captured {
	render(width: number): readonly string[];
}

function taskRow(overrides: Partial<BackgroundJobRow> = {}): BackgroundJobRow {
	return { type: "task", id: "SomeTask", summary: "summarized current action", ageMs: 83_000, ...overrides };
}

function runningTaskJob(overrides: Partial<AsyncJobSnapshotItem> = {}): AsyncJobSnapshotItem {
	return {
		id: "CoreFixes",
		type: "task",
		status: "running",
		label: "core auth hardening fixes",
		startTime: Date.now() - 5_000,
		...overrides,
	};
}

function makeCtx(opts: {
	running?: AsyncJobSnapshotItem[];
	recent?: AsyncJobSnapshotItem[];
	focusedAgentId?: string;
	describe?: (id: string) => string | undefined;
}) {
	const addChild = vi.fn();
	const removeChild = vi.fn();
	const state = { focusedAgentId: opts.focusedAgentId };
	const ctx = {
		subagentContainer: { addChild, removeChild, clear: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { columns: 200 } },
		settings: { get: () => false },
		describeSubagentJob: opts.describe ?? (() => undefined),
		get focusedAgentId() {
			return state.focusedAgentId;
		},
		session: {
			getAsyncJobSnapshot: () => ({
				running: opts.running ?? [],
				recent: opts.recent ?? [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, addChild, removeChild, state };
}

describe("renderBackgroundJobsLines", () => {
	it("returns no lines when nothing is running so the container clears", () => {
		expect(renderBackgroundJobsLines([], NO_SETTLED, 120)).toEqual([]);
	});

	it("renders the running-count header and a [task] Id: summary - age row", () => {
		const out = Bun.stripANSI(renderBackgroundJobsLines([taskRow()], NO_SETTLED, 120).join("\n"));
		expect(out).toContain("Background Jobs (1 running):");
		expect(out).toContain("[task] SomeTask: summarized current action - 1m23s");
	});

	it("renders shell jobs as [shell] cmd - age with no id or colon", () => {
		const out = Bun.stripANSI(
			renderBackgroundJobsLines(
				[{ type: "bash", id: "", summary: "pnpm test --filter x", ageMs: 5_000 }],
				NO_SETTLED,
				120,
			).join("\n"),
		);
		expect(out).toContain("[shell] pnpm test --filter x - 5s");
		expect(out).not.toContain("[shell] :");
	});

	it("appends settled counts to the header", () => {
		const out = Bun.stripANSI(
			renderBackgroundJobsLines([taskRow()], { completed: 2, failed: 1, cancelled: 0 }, 120).join("\n"),
		);
		expect(out).toContain("Background Jobs (1 running, 2 completed, 1 failed):");
	});

	it("truncates a long summary to fit the terminal width", () => {
		const out = Bun.stripANSI(
			renderBackgroundJobsLines([taskRow({ summary: "x".repeat(400) })], NO_SETTLED, 120).join("\n"),
		);
		const row = out.split("\n").find(line => line.includes("[task]")) ?? "";
		expect(row.length).toBeLessThanOrEqual(120);
		expect(row).toContain("…");
		expect(row).toContain("- 1m23s");
	});

	it("shows [research] instead of [task] when the job has agentType set", () => {
		const out = Bun.stripANSI(
			renderBackgroundJobsLines([taskRow({ agentType: "research" })], NO_SETTLED, 120).join("\n"),
		);
		expect(out).toContain("[research] SomeTask: summarized current action - 1m23s");
		expect(out).not.toContain("[task]");
	});

	it("keeps [task] for default worker jobs (agentType absent or 'task')", () => {
		const noAgentType = Bun.stripANSI(renderBackgroundJobsLines([taskRow()], NO_SETTLED, 120).join("\n"));
		expect(noAgentType).toContain("[task] SomeTask:");
		const defaultWorker = Bun.stripANSI(
			renderBackgroundJobsLines([taskRow({ agentType: "task" })], NO_SETTLED, 120).join("\n"),
		);
		expect(defaultWorker).toContain("[task] SomeTask:");
	});
});

describe("EventController background-jobs panel", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("renders running jobs into the anchored subagent container", () => {
		const { ctx, addChild } = makeCtx({ running: [runningTaskJob()] });
		new EventController(ctx).refreshBackgroundJobs();

		expect(addChild).toHaveBeenCalledTimes(1);
		const out = Bun.stripANSI((addChild.mock.calls[0][0] as Captured).render(200).join("\n"));
		expect(out).toContain("Background Jobs (1 running):");
		expect(out).toContain("[task]");
		expect(out).toContain("CoreFixes");
		// Falls back to the spawn description when no live action is reported.
		expect(out).toContain("core auth hardening fixes");
	});

	it("prefers the live current action over the spawn label for task rows", () => {
		const { ctx, addChild } = makeCtx({
			running: [runningTaskJob()],
			describe: id => (id === "CoreFixes" ? "patching the auth handler" : undefined),
		});
		new EventController(ctx).refreshBackgroundJobs();

		const out = Bun.stripANSI((addChild.mock.calls[0][0] as Captured).render(200).join("\n"));
		expect(out).toContain("patching the auth handler");
		expect(out).not.toContain("core auth hardening fixes");
	});

	it("labels task and shell jobs with distinct [task]/[shell] prefixes", () => {
		const { ctx, addChild } = makeCtx({
			running: [
				runningTaskJob({ id: "CoreFixes", label: "core auth hardening fixes" }),
				runningTaskJob({ id: "bg_2", type: "bash", label: "pnpm test" }),
			],
		});
		new EventController(ctx).refreshBackgroundJobs();

		const out = Bun.stripANSI((addChild.mock.calls[0][0] as Captured).render(200).join("\n"));
		expect(out).toContain("Background Jobs (2 running):");
		expect(out).toContain("[task]");
		expect(out).toContain("[shell]");
		expect(out).toContain("pnpm test");
	});

	it("suppresses the panel while observing a subagent and restores it on return", () => {
		const { ctx, addChild, removeChild, state } = makeCtx({ running: [runningTaskJob()] });
		const controller = new EventController(ctx);

		// Main view: panel renders.
		controller.refreshBackgroundJobs();
		expect(addChild).toHaveBeenCalledTimes(1);

		// Observe a subagent (Ctrl+S focus): the out-of-context panel is removed.
		state.focusedAgentId = "CoreFixes";
		controller.refreshBackgroundJobs();
		expect(removeChild).toHaveBeenCalledTimes(1);

		// Return to main: the panel comes back.
		state.focusedAgentId = undefined;
		controller.refreshBackgroundJobs();
		expect(addChild).toHaveBeenCalledTimes(2);
	});
});
