import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function classifierRefusalResponse(text: string): MockResponse {
	return {
		stopReason: "error",
		stopDetails: { type: "refusal" },
		errorMessage: text,
	};
}

async function promptWithMockResponse(session: AgentSession, text: string, response: MockResponse): Promise<void> {
	const mock = createMockModel({ responses: [response] });
	session.agent.streamFn = (model, context, options) => mock.stream(model, context, options);
	await session.agent.prompt(text);
}

async function refusalFiles(agentDir: string): Promise<string[]> {
	try {
		return (await fs.promises.readdir(path.join(agentDir, "refusals"))).filter(file => file.endsWith(".txt"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("InteractiveMode refusal transcript dumps", () => {
	let settingsState: SettingsTestState | undefined;
	let authStorage: AuthStorage | undefined;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;
	let tempDir: TempDir | undefined;
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-refusal-dump-");
		agentDir = path.join(tempDir.path(), "agent");
		setAgentDir(agentDir);
		await Settings.init({ inMemory: true, cwd: tempDir.path(), agentDir });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
		tempDir = undefined;
		agentDir = "";
		session = undefined;
		authStorage = undefined;
		mode = undefined;
	});

	it("saves a refusal transcript and available LLM request sidecar reference with auto-fix disabled", async () => {
		if (!session || !mode || !tempDir) throw new Error("test fixture not initialized");
		await mode.init({ suppressWelcomeIntro: true });
		session.settings.set("secrets.autoFixRefusal", false);
		const sidecarPath = path.join(tempDir.path(), "llm-request.json");
		vi.spyOn(session, "dumpLlmRequestToTmpDir").mockResolvedValue(sidecarPath);
		const saved = Promise.withResolvers<void>();
		vi.spyOn(mode, "showStatus").mockImplementation(message => {
			if (message.startsWith("Refusal saved to ")) saved.resolve();
		});

		await promptWithMockResponse(
			session,
			"request that must be refused",
			classifierRefusalResponse("Refusal (cyber): blocked"),
		);
		await session.waitForIdle();
		await saved.promise;

		const files = await refusalFiles(agentDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.txt$/);
		const document = await fs.promises.readFile(path.join(agentDir, "refusals", files[0]), "utf8");
		expect(document).toContain("## User");
		expect(document).toContain("## Assistant");
		expect(document).toContain("request that must be refused");
		expect(document).toContain("LLM request JSON: ");
		expect(document).toContain(sidecarPath);
	});

	it("does not write a refusal transcript for a non-refusal agent end", async () => {
		if (!session || !mode) throw new Error("test fixture not initialized");
		await mode.init({ suppressWelcomeIntro: true });
		session.settings.set("secrets.autoFixRefusal", false);

		await promptWithMockResponse(session, "ordinary request", { content: ["helpful answer"] });
		await session.waitForIdle();

		expect(await refusalFiles(agentDir)).toEqual([]);
	});
});
