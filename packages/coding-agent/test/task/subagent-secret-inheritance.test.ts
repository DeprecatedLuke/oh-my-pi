/**
 * Contract: a subagent spawned through the task executor redacts its spawner's
 * configured secrets, even when the secrets live only in the parent's project
 * `.omp/secrets.yml` and the subagent runs in a different cwd (isolated worktree,
 * scan root). The executor resolves the nearest live ancestor's obfuscator through
 * the agent registry; a child that rebuilt secrets from its own cwd would send the
 * secret in its assignment to the provider verbatim.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/subagent-secret-inheritance";
const SECRET = "SUBAGENT-LEAK-SENTINEL-d41c07";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;
let parent: AgentSession | undefined;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-secrets-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await parent?.dispose();
	parent = undefined;
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("redacts the spawning session's project secret from a subagent running in another cwd", async () => {
	const agentDir = path.join(root, "home", ".omp", "agent");
	const projectDir = path.join(root, "home", "project");
	// Outside the project: an isolated worktree or scan root never sees its `.omp/secrets.yml`.
	const childCwd = path.join(root, "home", "worktree");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
	await fs.mkdir(childCwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	await Bun.write(path.join(projectDir, ".omp", "secrets.yml"), `- { type: plain, content: "${SECRET}" }\n`);
	const parentObfuscator = await buildSecretObfuscator(projectDir, agentDir, agentDir);
	if (!parentObfuscator) throw new Error("Expected the project secrets file to produce an obfuscator");

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

	// Live main session holding the project obfuscator, and a parked intermediate parent:
	// the subagent must walk past the parked ref to the nearest live ancestor.
	parent = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(projectDir),
		settings: Settings.isolated({ "compaction.enabled": false, "secrets.enabled": true }),
		modelRegistry,
		obfuscator: parentObfuscator,
	});
	const registry = AgentRegistry.global();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: parent });
	registry.register({
		id: "Planner",
		displayName: "Planner",
		kind: "sub",
		parentId: "Main",
		session: null,
		status: "parked",
	});

	try {
		const result = await runSubprocess({
			cwd: childCwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: `Rotate the deploy token ${SECRET} and report done.`,
			index: 0,
			id: "Rotator",
			parentAgentId: "Planner",
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"secrets.enabled": true,
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);

		// The subagent's own turns are the ones offered the `yield` tool.
		const childRequests = mock.calls
			.filter(call => (call.context.tools ?? []).some(tool => tool.name === "yield"))
			.map(call => JSON.stringify(call.context.messages));
		expect(childRequests.length).toBeGreaterThan(0);
		expect(childRequests.some(request => request.includes("Rotate the deploy token"))).toBe(true);
		for (const request of childRequests) expect(request).not.toContain(SECRET);
		expect(childRequests.some(request => request.includes(parentObfuscator.obfuscate(SECRET)))).toBe(true);
	} finally {
		mock.reset();
		authStorage.close();
	}
}, 30_000);
