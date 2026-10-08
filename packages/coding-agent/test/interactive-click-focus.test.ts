import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

const PANEL_AGENT_ID = "PanelClickAgent";
const SYNC_AGENT_ID = "BlockingClickAgent";

describe("inline click-to-focus geometry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let eventBus: EventBus;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-click-focus-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 32);
		eventBus = new EventBus();
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, eventBus, composer);
	});
	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("maps a painted live task row back to its agent id", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const card = new ToolExecutionComponent(
			"task",
			{},
			{},
			undefined,
			{
				requestRender: () => mode.ui.requestRender(),
				requestComponentRender: () => {},
				resetDisplay: () => {},
			},
			tempDir.path(),
		);
		mode.chatContainer.addChild(card);
		const progress: AgentProgress = {
			index: 0,
			id: "ClickWorker",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "do clickable work",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		card.updateResult(
			{
				content: [{ type: "text", text: "Running 1 agent..." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 1, progress: [progress] },
			},
			true,
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("ClickWorker")));

		// Screen row (0-based from the top) into mutable-viewport coordinates,
		// exactly as the SGR click router computes it.
		const viewport = plainRows(term.getViewport());
		const screenRow = viewport.findIndex(row => row.includes("ClickWorker"));
		expect(screenRow).toBeGreaterThanOrEqual(0);
		const top = mode.ui.getMutableViewport().top;
		expect(mode.resolveViewportClickCandidates(screenRow - top)).toEqual(["ClickWorker"]);

		// Chrome rows (the status line at the bottom) name no agent.
		expect(mode.resolveViewportClickCandidates(viewport.length - 1 - top)).toEqual([]);
	});

	it("bands the hovered live card and clears it off-target", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const card = new ToolExecutionComponent(
			"task",
			{},
			{},
			undefined,
			{
				requestRender: () => mode.ui.requestRender(),
				requestComponentRender: () => {},
				resetDisplay: () => {},
			},
			tempDir.path(),
		);
		mode.chatContainer.addChild(card);
		card.updateResult(
			{
				content: [{ type: "text", text: "Running 1 agent..." }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 1,
					progress: [
						{
							index: 0,
							id: "HoverWorker",
							agent: "task",
							agentSource: "bundled",
							status: "running",
							task: "hoverable work",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 0,
							cost: 0,
							durationMs: 0,
						},
					],
				},
			},
			true,
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("HoverWorker")));

		const workerBg = (): number[] | undefined => {
			const rows = plainRows(term.getViewport());
			const row = rows.findIndex(line => line.includes("HoverWorker"));
			return row < 0 ? undefined : term.getViewportRowBackgroundValues(row);
		};
		const changed = (snapshot: number[] | undefined): boolean => {
			const now = workerBg();
			return now !== undefined && JSON.stringify(now) !== JSON.stringify(snapshot);
		};
		// Settle on a fresh frame so spans match the painted rows, then snapshot.
		mode.ui.requestRender();
		await term.waitForRender();
		const before = workerBg();
		expect(before).toBeDefined();
		// Motion is single-shot against the last painted spans, which can lag
		// one frame behind a just-mounted card: force a fresh frame, re-locate
		// by content, and retry until the band lands. The final expect still
		// fails loudly when nothing ever paints.
		for (let attempt = 0; attempt < 20; attempt++) {
			mode.ui.requestRender();
			await term.waitForRender();
			const rows = plainRows(term.getViewport());
			const row = rows.findIndex(line => line.includes("HoverWorker"));
			expect(row).toBeGreaterThanOrEqual(0);
			term.sendInput(`\x1b[<32;5;${row + 1}M`);
			await term.waitForRender(() => changed(before));
			if (changed(before)) break;
			if (attempt === 19) expect(changed(before)).toBe(true);
		}

		// Motion over the card bands its row.
		expect(changed(before)).toBe(true);

		// The live composer frame itself carries the band while hovered.
		const frame = mode.composer.renderFrame({ columns: 120, rows: 32 });
		expect(frame.viewport.filter(line => line.includes("\x1b[48")).length).toBeGreaterThan(0);

		// Disabling capture mid-hover clears the controller cache too: after
		// re-enabling, motion over the same card must restore the band instead
		// of looking unchanged and skipping the repaint.
		cfgTuiMouse.set(mode.settings, false);
		mode.ui.requestRender();
		await term.waitForRender(() => !changed(before));
		expect(workerBg()).toEqual(before);

		cfgTuiMouse.set(mode.settings, true);
		mode.ui.requestRender();
		await term.waitForRender();
		const cardRow = plainRows(term.getViewport()).findIndex(line => line.includes("HoverWorker"));
		expect(cardRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<32;5;${cardRow + 1}M`);
		await term.waitForRender(() => changed(before));
		expect(changed(before)).toBe(true);

		// Moving onto the status line restores the exact prior colors.
		const bottomRow = term.getViewport().length - 1;
		term.sendInput(`\x1b[<32;5;${bottomRow + 1}M`);
		await term.waitForRender(() => !changed(before));
		expect(workerBg()).toEqual(before);
	});

	it("lists job-backed and blocking subagents, focusing each on click and skipping non-agent rows", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		for (const id of [PANEL_AGENT_ID, SYNC_AGENT_ID]) {
			AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, sessionFile: null });
		}
		vi.spyOn(session, "getAsyncJobSnapshot").mockReturnValue({
			running: [
				{
					id: "panel-job",
					type: "task",
					status: "running",
					label: "panel work",
					startTime: Date.now() - 5_000,
					agentId: PANEL_AGENT_ID,
				},
				// A workpool aggregate: a task job with no agent behind it.
				{ id: "pool-job", type: "task", status: "running", label: "pool work", startTime: Date.now() - 5_000 },
				{
					id: "panel-shell",
					type: "bash",
					status: "running",
					label: "long-running shell job",
					startTime: Date.now() - 5_000,
				},
			],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		// A blocking task spawn: a live subagent with no async job.
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: SYNC_AGENT_ID,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "blocking work",
			status: "started",
			parentToolCallId: "tool-call",
			detached: false,
		});
		mode.refreshBackgroundJobs();

		const rows = (): string[] => plainRows(term.getViewport());
		const rowOf = (marker: string): number => rows().findIndex(row => row.includes(marker));
		const click = (row: number): void => term.sendInput(`\x1b[<0;5;${row + 1}M`);
		await term.waitForRender(() => rows().some(row => row.includes(SYNC_AGENT_ID)));
		expect(rows().some(row => row.includes("Background Jobs (4 running"))).toBe(true);

		// The title, the shell row, and the agentless pool row focus nothing.
		for (const marker of ["Background Jobs (", "pool work", "long-running shell job"]) {
			click(rowOf(marker));
			await term.waitForRender();
		}
		expect(mode.focusedAgentId).toBeUndefined();

		click(rowOf(SYNC_AGENT_ID));
		await term.waitForRender(() => mode.focusedAgentId === SYNC_AGENT_ID);
		await mode.unfocusSession();
		await term.waitForRender(() => rows().some(row => row.includes(PANEL_AGENT_ID)));
		click(rowOf(PANEL_AGENT_ID));
		await term.waitForRender(() => mode.focusedAgentId === PANEL_AGENT_ID);
		expect(mode.focusedAgentId).toBe(PANEL_AGENT_ID);
	});

	it("shows a running call's tool over a stale intent and counts a finished blocking subagent", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		vi.spyOn(session, "getAsyncJobSnapshot").mockReturnValue({
			running: [{ id: "keep", type: "bash", status: "running", label: "dev server", startTime: Date.now() }],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		const lifecycle = (status: "started" | "completed") =>
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: SYNC_AGENT_ID,
				index: 0,
				agent: "task",
				agentSource: "bundled",
				description: "blocking work",
				status,
				parentToolCallId: "tool-call",
				detached: false,
			});
		lifecycle("started");
		const progress: AgentProgress = {
			index: 0,
			id: SYNC_AGENT_ID,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "blocking work",
			lastIntent: "stale intent",
			currentTool: "mcp_lookup",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 0,
			cost: 0,
			durationMs: 1_000,
		};
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "blocking work",
			parentToolCallId: "tool-call",
			detached: false,
			progress,
		});
		mode.refreshBackgroundJobs();

		const rows = (): string[] => plainRows(term.getViewport());
		const syncRow = (): string | undefined => rows().find(row => row.includes(SYNC_AGENT_ID));
		await term.waitForRender(() => syncRow()?.includes("mcp_lookup") === true);
		expect(syncRow()).not.toContain("stale intent");

		lifecycle("completed");
		mode.refreshBackgroundJobs();
		await term.waitForRender(() => rows().some(row => row.includes("Background Jobs (1 running, 1 completed)")));
		expect(syncRow()).toBeUndefined();
	});
});
