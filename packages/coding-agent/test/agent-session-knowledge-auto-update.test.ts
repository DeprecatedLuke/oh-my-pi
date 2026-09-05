import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as taskModule from "@oh-my-pi/pi-coding-agent/task";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as knowledgeModule from "@oh-my-pi/pi-coding-agent/session/knowledge-base";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOOP_PASS = { exitCode: 0, aborted: false, patches: [], summary: "No changes to apply." };

type UsageOverrides = Partial<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}>;

interface HarnessOptions {
	agentId?: string;
	followUpUsage?: UsageOverrides;
	persist?: boolean;
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	manager: AsyncJobManager;
	authStorage: AuthStorage;
	tempDir: TempDir;
}

async function createHarness(threshold: number, options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-knowledge-auto-update-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const model = createMockModel({
		provider: "mock",
		responses: [
			{ content: ["Primary response"], usage: { output: 5, totalTokens: 5 } },
			{
				content: ["Primary response"],
				usage: options.followUpUsage ?? { output: 1, totalTokens: 1 },
			},
		],
	});
	const settings = Settings.isolated({
		"knowledge.autoUpdateThresholdTokens": threshold,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	const sessionManager = options.persist
		? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"))
		: SessionManager.inMemory(tempDir.path());
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: model.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		asyncJobManager: manager,
		agentId: options.agentId,
	});
	return { session, sessionManager, manager, authStorage, tempDir };
}

async function disposeHarness(harness: Harness): Promise<void> {
	try {
		await harness.session.dispose();
	} finally {
		try {
			await harness.manager.dispose({ timeoutMs: 1_000 });
		} finally {
			harness.authStorage.close();
			harness.tempDir.removeSync();
		}
	}
}

function autoUpdateMarkers(sessionManager: SessionManager) {
	return sessionManager
		.getBranch()
		.filter(
			entry => entry.type === "custom" && entry.customType === knowledgeModule.KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE,
		);
}

describe("AgentSession automatic knowledge updates", () => {
	it("runs one internal patch pass and records one durable marker without a visible job or async-result follow-up", async () => {
		const harness = await createHarness(1);
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockResolvedValue(NOOP_PASS);
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			const branch = harness.sessionManager.getBranch();
			const throughEntryId = branch
				.filter(entry => entry.type === "message" && entry.message.role === "assistant")
				.at(-1)?.id;

			expect(patchPassSpy).toHaveBeenCalledTimes(1);
			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(
				branch.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "custom" &&
						entry.message.customType === "async-result",
				),
			).toBe(false);

			const markers = autoUpdateMarkers(harness.sessionManager);
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({ data: { throughEntryId } });
		} finally {
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("excludes cache reads from automatic threshold accounting", async () => {
		const harness = await createHarness(6, {
			followUpUsage: { output: 0, cacheRead: 133_000, totalTokens: 133_000 },
		});
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockResolvedValue(NOOP_PASS);
		try {
			await harness.session.prompt("Record the first session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			await harness.session.prompt("Record the cache-heavy session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			// The two assistant turns contain five non-cached work tokens in
			// total. The second turn's large cache read must not cross six.
			expect(patchPassSpy).not.toHaveBeenCalled();
			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not start a second automatic pass while the first pass is in flight", async () => {
		const harness = await createHarness(5);
		const passStarted = Promise.withResolvers<void>();
		const passRelease = Promise.withResolvers<typeof NOOP_PASS>();
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockImplementation(async () => {
			passStarted.resolve();
			return passRelease.promise;
		});
		try {
			await harness.session.prompt("Record the first session fact");
			await harness.session.waitForIdle();
			await passStarted.promise;

			expect(patchPassSpy).toHaveBeenCalledTimes(1);
			await harness.session.prompt("Record the second session fact");
			await harness.session.waitForIdle();

			// The second response brings the accumulated range above the
			// threshold, but the in-flight first pass still owns the slot.
			expect(patchPassSpy).toHaveBeenCalledTimes(1);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);

			passRelease.resolve(NOOP_PASS);
			await harness.session.settleAsyncWork();

			expect(patchPassSpy).toHaveBeenCalledTimes(1);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(1);
		} finally {
			passRelease.resolve(NOOP_PASS);
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not mark a completed pass after the active branch moves before its captured message", async () => {
		const harness = await createHarness(1);
		const passStarted = Promise.withResolvers<void>();
		const passRelease = Promise.withResolvers<typeof NOOP_PASS>();
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockImplementation(async () => {
			passStarted.resolve();
			return passRelease.promise;
		});
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();

			const capturedBranch = harness.sessionManager.getBranch();
			const userEntry = capturedBranch.find(entry => entry.type === "message" && entry.message.role === "user");
			const throughEntryId = capturedBranch
				.filter(entry => entry.type === "message" && entry.message.role === "assistant")
				.at(-1)?.id;
			if (!userEntry || userEntry.type !== "message" || !throughEntryId) {
				throw new Error("expected persisted user and assistant messages");
			}
			const sessionId = harness.sessionManager.getSessionId();

			expect(harness.manager.getAllJobs()).toHaveLength(0);
			await passStarted.promise;

			harness.sessionManager.branch(userEntry.id);
			expect(harness.sessionManager.getSessionId()).toBe(sessionId);
			expect(harness.sessionManager.getBranch().some(entry => entry.id === throughEntryId)).toBe(false);

			passRelease.resolve(NOOP_PASS);
			await harness.session.settleAsyncWork();

			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			passRelease.resolve(NOOP_PASS);
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not mark a completed pass in the forked session after the transition starts", async () => {
		const harness = await createHarness(1, { persist: true });
		const passStarted = Promise.withResolvers<void>();
		const passRelease = Promise.withResolvers<typeof NOOP_PASS>();
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockImplementation(async () => {
			passStarted.resolve();
			return passRelease.promise;
		});
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();
			await passStarted.promise;

			const previousSessionId = harness.sessionManager.getSessionId();
			const forkPromise = harness.session.fork();
			passRelease.resolve(NOOP_PASS);

			expect(await forkPromise).toBe(true);
			expect(harness.sessionManager.getSessionId()).not.toBe(previousSessionId);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			passRelease.resolve(NOOP_PASS);
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not mark a completed pass after the active session moves to a new cwd", async () => {
		const harness = await createHarness(1);
		const passStarted = Promise.withResolvers<void>();
		const passRelease = Promise.withResolvers<typeof NOOP_PASS>();
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockImplementation(async () => {
			passStarted.resolve();
			return passRelease.promise;
		});
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();
			await passStarted.promise;

			const movedCwd = path.join(harness.tempDir.path(), "moved-project");
			const movePromise = harness.session.moveSession(movedCwd);
			passRelease.resolve(NOOP_PASS);

			await movePromise;
			expect(harness.sessionManager.getCwd()).toBe(path.resolve(movedCwd));
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			passRelease.resolve(NOOP_PASS);
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not mark a failed pass and retries the accumulated range on the next terminal prompt", async () => {
		const harness = await createHarness(5);
		const patchPassSpy = vi
			.spyOn(taskModule, "runInProcessKnowledgePatchPass")
			.mockRejectedValueOnce(new Error("test knowledge pass failure"))
			.mockResolvedValueOnce(NOOP_PASS);
		try {
			await harness.session.prompt("Record the first session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			expect(patchPassSpy).toHaveBeenCalledTimes(1);
			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);

			await harness.session.prompt("Record the second session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			// The first pass's five tokens remain pending; the second response
			// adds one token, so the accumulated range crosses the threshold.
			expect(patchPassSpy).toHaveBeenCalledTimes(2);
			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(1);
		} finally {
			patchPassSpy.mockRestore();
			await disposeHarness(harness);
		}
	});

	it("does not schedule or mark a terminal turn when the threshold is disabled at zero", async () => {
		const harness = await createHarness(0);
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();
			await harness.session.settleAsyncWork();

			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			await disposeHarness(harness);
		}
	});
});
