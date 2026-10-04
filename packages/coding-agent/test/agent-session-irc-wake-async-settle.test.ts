/**
 * Regression: an IRC wake turn that backgrounds an owner-scoped job and ends
 * with plain text is a scheduling pause, not a terminal stop. The wake
 * observation's finish callback must stay open until the job's async-result
 * continuation turn (where the woken subagent submits its terminal yield)
 * has settled — finishing at the first settle relays the interim text,
 * detaches the monitor, and the parent never receives the result.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockCall, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const yieldToolSchema = type({ data: type("unknown") });

const OWNER = "WakeSubAgent";
const JOB_ID = "wake-job";
const RESULT_MARKER = "WAKE-CONTINUATION-RESULT";

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

function yieldCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "yield", arguments: { data: { value } } }],
		stopReason: "toolUse",
	};
}

function ircMessage(id: string): IrcMessage {
	return { id, from: "parent", to: OWNER, body: "wake up", ts: Date.now() } as IrcMessage;
}

/** Drain every pending microtask/macrotask without wall-clock waiting. */
async function drainMacrotasks(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await setImmediate;
}

const activeSessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of activeSessions.splice(0)) {
		await session.dispose();
	}
	AsyncJobManager.resetForTests();
});

async function createSession(mock: MockModel, yieldValues: unknown[]): Promise<AgentSession> {
	const manager = new AsyncJobManager({});
	AsyncJobManager.setInstance(manager);
	const yieldTool: AgentTool<typeof yieldToolSchema, { value: unknown }> = {
		name: "yield",
		label: "Submit Result",
		description: "Finish the task with structured JSON output.",
		parameters: yieldToolSchema,
		async execute(_toolCallId, params) {
			yieldValues.push(params.data ?? null);
			return {
				content: [{ type: "text", text: "Result submitted." }],
				details: { value: params.data ?? null },
			};
		},
	};
	const tools = [yieldTool];
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: sharedModelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		agentId: OWNER,
		asyncJobManager: manager,
	});
	activeSessions.push(session);
	return session;
}

/** Owner-scoped background job whose completion the test controls. */
function registerGatedWakeJob(
	manager: AsyncJobManager,
	jobStarted: PromiseWithResolvers<void>,
	jobGate: PromiseWithResolvers<string>,
): void {
	manager.register(
		"bash",
		"gated wake job",
		async ({ signal }) => {
			jobStarted.resolve();
			return new Promise<string>((resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("wake job cancelled")), { once: true });
				void jobGate.promise.then(resolve, reject);
			});
		},
		{ id: JOB_ID, ownerId: OWNER },
	);
}

function contextText(call: MockCall): string {
	return call.context.messages
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(block => (block.type === "text" ? block.text : "")).join("\n"),
		)
		.join("\n");
}

describe("AgentSession IRC wake observation settles owner async work", () => {
	it("holds the wake observation open until the background job's async-result continuation settles", async () => {
		const yieldValues: unknown[] = [];
		const events: string[] = [];
		let modelCalls = 0;
		let finishCount = 0;
		const jobStarted = Promise.withResolvers<void>();
		const wakeTurnGate = Promise.withResolvers<void>();
		const jobGate = Promise.withResolvers<string>();
		const finishSettled = Promise.withResolvers<void>();

		const mock = createMockModel({
			handler: async () => {
				modelCalls++;
				events.push(`model-call:${modelCalls}`);
				if (modelCalls === 1) {
					// The woken subagent backgrounds a job mid-turn, then ends the
					// turn with plain text ("waiting for the job").
					registerGatedWakeJob(session.asyncJobManager!, jobStarted, jobGate);
					await wakeTurnGate.promise;
					return { content: ["backgrounded the job; waiting for it"] };
				}
				if (modelCalls > 2) throw new Error(`unexpected extra model call ${modelCalls}`);
				// The async-result continuation: the subagent submits its yield here.
				return yieldCall("submitted after wake", "call-yield-after-async-result");
			},
		});
		const session = await createSession(mock, yieldValues);
		session.subscribe(event => {
			if (event.type === "agent_end") events.push(`agent_end:${mock.calls.length}`);
		});
		session.setIrcWakeTurnObserver(() => {
			events.push("observer-start");
			return () => {
				finishCount++;
				events.push(`observer-finish:${mock.calls.length}`);
				finishSettled.resolve();
			};
		});

		expect(await session.deliverIrcMessage(ircMessage("wake-1"))).toBe("woken");
		await jobStarted.promise;
		expect(session.asyncJobManager!.getJob(JOB_ID)?.status).toBe("running");
		wakeTurnGate.resolve();
		await session.waitForIdle();

		// (1) The wake turn has ended, but the observation must still be open
		// while the owner job is still running: finish is gated on the job, so
		// no amount of event-loop draining can fire it.
		await drainMacrotasks();
		expect(finishCount).toBe(0);
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(events).toEqual(["observer-start", "model-call:1", "agent_end:1"]);

		// (2) Resolving the job delivers its async-result as a continuation turn
		// (the model is called again and yields); only after that settles does
		// the observation finish.
		jobGate.resolve(`job finished: ${RESULT_MARKER}`);
		await finishSettled.promise;

		expect(mock.calls).toHaveLength(2);
		expect(events).toEqual([
			"observer-start",
			"model-call:1",
			"agent_end:1",
			"model-call:2",
			"agent_end:2",
			"observer-finish:2",
		]);
		expect(contextText(mock.calls[1]!)).toContain(RESULT_MARKER);
		expect(yieldValues).toEqual([{ value: "submitted after wake" }]);
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("an abort during the wake turn finishes the observation without waiting for the job", async () => {
		const yieldValues: unknown[] = [];
		let modelCalls = 0;
		let finishCount = 0;
		const jobStarted = Promise.withResolvers<void>();
		const wakeTurnGate = Promise.withResolvers<void>();
		const jobGate = Promise.withResolvers<string>();
		const finishSettled = Promise.withResolvers<void>();

		const mock = createMockModel({
			handler: async () => {
				modelCalls++;
				if (modelCalls === 1) {
					registerGatedWakeJob(session.asyncJobManager!, jobStarted, jobGate);
					// Hold the wake turn open so the abort lands before the
					// observation's first settle.
					await wakeTurnGate.promise;
					return { content: ["backgrounded the job; waiting for it"] };
				}
				throw new Error(`unexpected model call ${modelCalls}`);
			},
		});
		const session = await createSession(mock, yieldValues);
		session.setIrcWakeTurnObserver(() => {
			return () => {
				finishCount++;
				finishSettled.resolve();
			};
		});

		expect(await session.deliverIrcMessage(ircMessage("wake-abort"))).toBe("woken");
		await jobStarted.promise;
		// Aborting bumps the prompt generation while the wake turn is still
		// streaming; the observation must then finish without waiting for the job.
		const aborted = session.abort();
		wakeTurnGate.resolve();
		await aborted;
		await session.waitForIdle();
		await finishSettled.promise;

		expect(finishCount).toBe(1);
		// The job was never resolved: finish did not wait for it, and no
		// async-result continuation ever ran.
		expect(session.asyncJobManager!.getJob(JOB_ID)?.status).toBe("running");
		expect(mock.calls).toHaveLength(1);
	});
});
