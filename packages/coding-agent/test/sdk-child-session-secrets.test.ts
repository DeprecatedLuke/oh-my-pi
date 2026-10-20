/**
 * Contract: a child session created with its parent's secret obfuscator redacts the
 * parent's configured secrets even when its cwd is outside the parent's project.
 *
 * Subagents, isolated worktrees, and security scans run in a different cwd than the
 * session that spawned them. The parent's secrets may live only in its project's
 * `.omp/secrets.yml`; a child that re-resolved secrets from its own cwd would never
 * load that file and would ship the secret to its provider verbatim.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SECRET = "CHILD-LEAK-SENTINEL-b83d10";

describe("child session secret inheritance", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		clearCustomApis();
	});

	it("redacts the parent's project-scoped secret from a child running in a different cwd", async () => {
		using root = TempDir.createSync("@pi-child-secrets-");
		const projectDir = root.join("project");
		const childCwd = root.join("elsewhere");
		const agentDir = root.join("agent");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(childCwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(projectDir, ".omp", "secrets.yml"), `- { type: plain, content: "${SECRET}" }\n`);

		// The parent session's obfuscator, resolved from the parent's project.
		const parentObfuscator = await buildSecretObfuscator(projectDir, agentDir, agentDir);
		if (!parentObfuscator) throw new Error("Expected the project secrets file to produce an obfuscator");
		const placeholder = parentObfuscator.obfuscate(SECRET);
		expect(placeholder).not.toContain(SECRET);

		const api = "test-child-session-secrets";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "child-session-secrets",
			name: "Child session secrets",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");

		try {
			const { session } = await createAgentSession({
				cwd: childCwd,
				agentDir,
				sessionManager: SessionManager.inMemory(childCwd),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
				// The child inherits secrets.enabled from its parent's settings.
				settings: Settings.isolated({ "compaction.enabled": false, "secrets.enabled": true }),
				model,
				obfuscator: parentObfuscator,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			sessions.push(session);

			await session.sendUserMessage(`Deploy using the token ${SECRET} and report back.`);

			expect(contexts).toHaveLength(1);
			const request = JSON.stringify(contexts[0]);
			expect(request).not.toContain(SECRET);
			expect(request).toContain(placeholder);
		} finally {
			authStorage.close();
		}
	});
});
