import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as fixRefusalHelpers from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/fix-refusal";
import { TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function classifierRefusal(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {},
		stopReason: "error",
		stopDetails: { type: "refusal" },
		errorMessage: text,
	} as unknown as AssistantMessage;
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.disableLoopMode("Loop mode disabled.");
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("disables reset loops when vibe blocks the session transition", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "reset");
		mode.vibeModeEnabled = true;
		mode.loopModeEnabled = true;
		mode.loopPrompt = "do not resubmit";
		const showStatus = vi.spyOn(mode, "showStatus");
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
	});

	it("reports waiting, running, paused, resumed, and disabled loop states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		await mode.handleLoopCommand("3");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "waiting",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.pauseLoop();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("resume this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});

	it("resubmits the latest prompt after an automatic refusal fix", async () => {
		session.settings.set("secrets.autoFixRefusal", true);
		session.settings.setModelRole("uncensored", "anthropic/claude-sonnet-4-5");
		const fixSpy = vi.spyOn(fixRefusalHelpers, "executeFixRefusal").mockResolvedValue({
			resolved: true,
			saved: 1,
			patternsActive: 1,
		});
		const submissions: SubmittedUserInput[] = [];
		mode.onInputCallback = input => submissions.push(input);
		await mode.init();

		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "original request" }],
			timestamp: Date.now(),
		});
		const refusal = classifierRefusal("Refusal (cyber): blocked");
		session.agent.appendMessage(refusal);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [refusal] });
		await session.waitForIdle();
		await flushMicrotasks();

		expect(fixSpy).toHaveBeenCalledTimes(1);
		expect(submissions).toEqual([
			expect.objectContaining({
				text: "original request",
				customType: "auto-fix-refusal",
			}),
		]);
	});

	it("defers refusal fixing until a blocked agent_end settles", async () => {
		session.settings.set("secrets.autoFixRefusal", true);
		session.settings.setModelRole("uncensored", "anthropic/claude-sonnet-4-5");
		const fixSpy = vi.spyOn(fixRefusalHelpers, "executeFixRefusal").mockResolvedValue({
			resolved: true,
			saved: 1,
			patternsActive: 1,
		});
		const submissions: SubmittedUserInput[] = [];
		mode.onInputCallback = input => submissions.push(input);
		let blocked = true;
		Object.defineProperty(session, "hasPostPromptWork", {
			configurable: true,
			get: () => blocked,
		});
		await mode.init();

		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "deferred request" }],
			timestamp: Date.now(),
		});
		const refusal = classifierRefusal("Refusal (cyber): blocked");
		session.agent.appendMessage(refusal);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [refusal] });
		await flushMicrotasks();

		expect(fixSpy).not.toHaveBeenCalled();
		expect(submissions).toEqual([]);

		blocked = false;
		await session.waitForIdle();
		await flushMicrotasks();

		expect(fixSpy).toHaveBeenCalledTimes(1);
		expect(submissions).toEqual([
			expect.objectContaining({
				text: "deferred request",
				customType: "auto-fix-refusal",
			}),
		]);
	});

	it("does not resubmit after a non-refusal agent end", async () => {
		session.settings.set("secrets.autoFixRefusal", true);
		session.settings.setModelRole("uncensored", "anthropic/claude-sonnet-4-5");
		const fixSpy = vi.spyOn(fixRefusalHelpers, "executeFixRefusal");
		const submissions: SubmittedUserInput[] = [];
		mode.onInputCallback = input => submissions.push(input);
		await mode.init();

		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "ordinary request" }],
			timestamp: Date.now(),
		});
		const answer = {
			role: "assistant",
			content: [{ type: "text", text: "helpful answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {},
			stopReason: "stop",
		} as unknown as AssistantMessage;
		session.agent.appendMessage(answer);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [answer] });
		await flushMicrotasks();

		expect(fixSpy).not.toHaveBeenCalled();
		expect(submissions).toEqual([]);
	});
});
