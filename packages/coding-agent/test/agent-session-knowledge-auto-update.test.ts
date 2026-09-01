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
import { KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/knowledge-base";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOOP_PASS = { exitCode: 0, aborted: false, patches: [], summary: "No changes to apply." };

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	manager: AsyncJobManager;
	authStorage: AuthStorage;
	tempDir: TempDir;
}

async function createHarness(threshold: number): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-knowledge-auto-update-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const model = createMockModel({
		provider: "mock",
		responses: [{ content: ["Primary response"], usage: { totalTokens: 5 } }],
	});
	const settings = Settings.isolated({
		"knowledge.autoUpdateThresholdTokens": threshold,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
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
		.filter(entry => entry.type === "custom" && entry.customType === KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE);
}

describe("AgentSession automatic knowledge updates", () => {
	it("schedules one terminal KnowledgeDistill job and records one durable marker", async () => {
		const harness = await createHarness(1);
		const patchPassSpy = vi.spyOn(taskModule, "runInProcessKnowledgePatchPass").mockResolvedValue(NOOP_PASS);
		try {
			await harness.session.prompt("Record this session fact");
			await harness.session.waitForIdle();

			const throughEntryId = harness.sessionManager
				.getBranch()
				.filter(entry => entry.type === "message")
				.at(-1)?.id;
			if (!throughEntryId) throw new Error("expected the terminal assistant message to be persisted");

			const jobs = harness.manager.getAllJobs();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({ type: "task", label: "KnowledgeDistill" });

			await harness.manager.waitForAll();

			const markers = autoUpdateMarkers(harness.sessionManager);
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({ data: { throughEntryId } });
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

			expect(harness.manager.getAllJobs()).toHaveLength(0);
			expect(autoUpdateMarkers(harness.sessionManager)).toHaveLength(0);
		} finally {
			await disposeHarness(harness);
		}
	});
});
