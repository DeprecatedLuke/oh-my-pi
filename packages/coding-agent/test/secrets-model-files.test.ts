/**
 * Tests for `secrets.modelFiles`: per-model secrets files that replace the global
 * agent-dir `secrets.yml` / `secrets-managed.yml` for matching models.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-5" };
const OPUS = { provider: "anthropic", id: "claude-opus-4-5" };

/** Unique per call so values autoloaded into process.env from the repo's own `.env` cannot collide. */
function uniqueSecret(prefix: string): string {
	return `${prefix}${crypto.randomBytes(16).toString("hex")}`;
}

async function writeSecretsFile(filePath: string, ...values: string[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, values.map(value => `- type: plain\n  content: ${value}\n`).join(""));
}

describe("secrets.modelFiles", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let globalValue: string;
	let opusValue: string;
	let projectValue: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-model-files-"));
		cwd = path.join(root, "cwd");
		agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		globalValue = uniqueSecret("global");
		opusValue = uniqueSecret("opus");
		projectValue = uniqueSecret("project");
		await writeSecretsFile(path.join(agentDir, "secrets.yml"), globalValue);
		await writeSecretsFile(path.join(agentDir, "opus.yml"), opusValue);
		await writeSecretsFile(path.join(cwd, ".omp", "secrets.yml"), projectValue);
	});

	afterEach(async () => {
		clearCustomApis();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("replaces the global secrets files for a matching model while project secrets apply to every model", async () => {
		const group = await buildSecretObfuscator(cwd, agentDir, agentDir, { "*opus*": "opus.yml" });
		if (!group) throw new Error("expected a secrets transformer group");
		const text = `g=${globalValue} o=${opusValue} p=${projectValue}`;

		const opusMasked = group.forModel(OPUS).obfuscate(text);
		expect(opusMasked).not.toContain(opusValue);
		expect(opusMasked).toContain(globalValue);
		expect(opusMasked).not.toContain(projectValue);

		const sonnetMasked = group.forModel(SONNET).obfuscate(text);
		expect(sonnetMasked).not.toContain(globalValue);
		expect(sonnetMasked).toContain(opusValue);
		expect(sonnetMasked).not.toContain(projectValue);
	});

	it("restores placeholders minted by any member of the group", async () => {
		const group = await buildSecretObfuscator(cwd, agentDir, agentDir, { "*opus*": "opus.yml" });
		if (!group) throw new Error("expected a secrets transformer group");
		const opus = group.forModel(OPUS);
		const sonnet = group.forModel(SONNET);

		const opusMasked = opus.obfuscate(`o=${opusValue}`);
		const sonnetMasked = sonnet.obfuscate(`g=${globalValue}`);
		expect(opusMasked).not.toContain(opusValue);
		expect(sonnetMasked).not.toContain(globalValue);

		expect(sonnet.deobfuscate(opusMasked)).toBe(`o=${opusValue}`);
		expect(opus.deobfuscate(sonnetMasked)).toBe(`g=${globalValue}`);
	});

	it("drops the global files for a model mapped to an empty list but keeps built-in credential patterns", async () => {
		const group = await buildSecretObfuscator(cwd, agentDir, agentDir, { "*opus*": [] });
		if (!group) throw new Error("expected a secrets transformer group");
		const githubToken = `ghp_${"aB3".repeat(12)}`;

		const opusMasked = group.forModel(OPUS).obfuscate(`g=${globalValue} t=${githubToken}`);
		expect(opusMasked).toContain(globalValue);
		expect(opusMasked).not.toContain(githubToken);

		expect(group.forModel(SONNET).obfuscate(`g=${globalValue}`)).not.toContain(globalValue);
	});

	it("redacts session requests with the set of the model active after a switch", async () => {
		const api = "test-secrets-model-files";
		const requests: Array<{ modelId: string; body: string }> = [];
		registerCustomApi(api, (model, context: Context) => {
			requests.push({ modelId: model.id, body: JSON.stringify(context.messages) });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("done");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const makeModel = (id: string): Model<Api> =>
			buildModel({
				id,
				name: id,
				api,
				provider: "test-provider",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;
		const sonnetModel = makeModel("test-sonnet-model");
		const opusModel = makeModel("test-opus-model");

		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.keys.setRuntime("test-provider", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"secrets.enabled": true,
					"secrets.modelFiles": { "*opus*": "opus.yml" },
				}),
				model: sonnetModel,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: [],
			}));

			await session.sendUserMessage(`first g=${globalValue} o=${opusValue}`);
			await session.setModelTemporary(opusModel);
			await session.sendUserMessage(`second g=${globalValue} o=${opusValue}`);

			expect(requests.map(request => request.modelId)).toEqual(["test-sonnet-model", "test-opus-model"]);
			const [sonnetRequest, opusRequest] = requests;
			expect(sonnetRequest.body).not.toContain(globalValue);
			expect(sonnetRequest.body).toContain(opusValue);
			expect(opusRequest.body).toContain("second");
			expect(opusRequest.body).not.toContain(opusValue);
			expect(opusRequest.body).toContain(globalValue);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});
});
