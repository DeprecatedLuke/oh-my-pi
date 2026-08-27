/**
 * Contract: InteractiveMode's anchored panel is the user-visible Background
 * Jobs view, refreshed once after a burst of coalesced subagent progress.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentProgressPayload,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

describe("InteractiveMode Background Jobs observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let asyncJobManager: AsyncJobManager;
	let releaseJobs: Array<(result: string) => void>;
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		asyncJobManager = new AsyncJobManager({ maxRunningJobs: 6 });
		releaseJobs = [];
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
			asyncJobManager,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		for (const release of releaseJobs ?? []) release("done");
		await asyncJobManager?.dispose({ timeoutMs: 100 });
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("refreshes one anchored Background Jobs panel after a burst of progress updates", async () => {
		// Register the jobs BEFORE mode.init subscribes to the manager's
		// onChange, so the burst's observer coalescing (not job registration)
		// is what drives the single panel refresh under test.
		for (let index = 0; index < 6; index++) {
			const gate = Promise.withResolvers<string>();
			releaseJobs.push(gate.resolve);
			asyncJobManager.register("task", `Burst job ${index}`, () => gate.promise, {
				id: `BurstAgent${index}`,
				agentType: "task",
			});
		}

		await mode.init({ suppressWelcomeIntro: true });

		vi.useFakeTimers();
		const refreshBackgroundJobs = vi.spyOn(mode.eventController, "refreshBackgroundJobs");
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const addPanel = vi.spyOn(mode.subagentContainer, "addChild");

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.advanceTimersByTime(100); // SUBAGENT_OBSERVER_UI_COALESCE_MS
		await Promise.resolve();

		const panel = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(panel).toContain("Background Jobs (6 running):");
		expect(panel).toContain("BurstAgent0");
		expect(panel).toContain("BurstAgent5");
		expect(panel).not.toContain("Subagents");
		expect(addPanel).toHaveBeenCalledTimes(1);
		expect(refreshBackgroundJobs).toHaveBeenCalledTimes(1);
	});
});
