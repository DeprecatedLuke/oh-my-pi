import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Message } from "@oh-my-pi/pi-ai/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import {
	collectKnowledgeAutoUpdateSource,
	KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE,
	runSessionKnowledgeAgent,
} from "@oh-my-pi/pi-coding-agent/session/knowledge-base";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadKnowledgeSummaries } from "@oh-my-pi/pi-coding-agent/session/knowledge-index";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return stdout.trim();
}

/** Init a repo with one tracked file OUTSIDE `.omp/knowledge`, committed once. */
async function initRepo(prefix: string): Promise<string> {
	const repo = await tempDir(prefix);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "outside.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

function assistantMessage(text: string, totalTokens: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as Message;
}

function toolResultMessage(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "tool-call",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function messageEntry(id: string, message: Message): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function customEntry(id: string, customType: string, data?: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		data,
	};
}

function modelUsageEntry(id: string, totalTokens: number): SessionEntry {
	return {
		type: "model_usage",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		purpose: "sidecar",
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("automatic knowledge-update cadence", () => {
	it("uses a 100_000-token default and treats zero as the disabled sentinel", () => {
		const defaults = Settings.isolated();
		const disabled = Settings.isolated({ "knowledge.autoUpdateThresholdTokens": 0 });

		expect(defaults.get("knowledge.autoUpdateThresholdTokens")).toBe(100_000);
		expect(disabled.get("knowledge.autoUpdateThresholdTokens")).toBe(0);
	});

	it("keeps post-marker session messages in order while counting only positive finite assistant usage", () => {
		const entries: SessionEntry[] = [
			messageEntry("before-marker", userMessage("old context")),
			customEntry("marker", KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE),
			messageEntry("user", userMessage("new context")),
			modelUsageEntry("sidecar-usage", 500),
			messageEntry("assistant-positive", assistantMessage("first answer", 7)),
			customEntry("sidecar-custom", "other-extension"),
			messageEntry("tool-result", toolResultMessage("tool output")),
			messageEntry("assistant-nan", assistantMessage("invalid nan", Number.NaN)),
			messageEntry("assistant-infinity", assistantMessage("invalid infinity", Number.POSITIVE_INFINITY)),
			messageEntry("assistant-negative", assistantMessage("invalid negative", -3)),
			messageEntry("assistant-positive-2", assistantMessage("second answer", 10)),
		];

		const source = collectKnowledgeAutoUpdateSource(entries);

		expect(source.messages.map(entry => entry.id)).toEqual([
			"user",
			"assistant-positive",
			"tool-result",
			"assistant-nan",
			"assistant-infinity",
			"assistant-negative",
			"assistant-positive-2",
		]);
		expect(source.totalTokens).toBe(17);
	});

	it("keeps messages and tokens appended before a completion marker whose boundary is older", () => {
		const source = collectKnowledgeAutoUpdateSource([
			messageEntry("old-user", userMessage("already processed")),
			messageEntry("old-assistant", assistantMessage("old answer", 40)),
			messageEntry("new-user", userMessage("arrived during distill")),
			messageEntry("new-assistant", assistantMessage("new answer", 3)),
			customEntry("completion-marker", KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE, {
				throughEntryId: "old-assistant",
			}),
		]);

		expect(source.messages.map(entry => entry.id)).toEqual(["new-user", "new-assistant"]);
		expect(source.totalTokens).toBe(3);
	});

	it("resets both the source messages and token total at the latest persisted marker", () => {
		const source = collectKnowledgeAutoUpdateSource([
			customEntry("first-marker", KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE),
			messageEntry("old-user", userMessage("already distilled")),
			messageEntry("old-assistant", assistantMessage("old answer", 40)),
			modelUsageEntry("old-sidecar", 1000),
			customEntry("latest-marker", KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE),
			messageEntry("new-user", userMessage("resume branch input")),
			messageEntry("new-assistant", assistantMessage("new answer", 3)),
		]);

		expect(source.messages.map(entry => entry.id)).toEqual(["new-user", "new-assistant"]);
		expect(source.totalTokens).toBe(3);
	});
});

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function knowledgeToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

/** A mock model that emits one `write knowledge://…` tool call, then ends the turn. */
function writeThenStopModel(toolArguments: { path: string; content: string }) {
	return createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "write", arguments: toolArguments }] },
			{ content: ["Knowledge updated."] },
		],
	});
}

describe("runSessionKnowledgeAgent", () => {
	it("drives the write tool to update .omp/knowledge, then commits only that subtree", async () => {
		const repo = await initRepo("pi-knowledge-loop-");
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);
		const model = writeThenStopModel({
			path: "knowledge://workflows/smoke-tests.md",
			content:
				"---\ndescription: smoke tests, ci:test:smoke\n---\n\n# Smoke Tests\n\n- Run ci:test:smoke after worker changes.\n",
		});
		const session = knowledgeToolSession(repo);

		const result = await runSessionKnowledgeAgent({
			cwd: repo,
			sourceTitle: "handoff session",
			instruction: "Update the project knowledge base from this session.",
			agent: {
				initialState: {
					systemPrompt: ["Base prompt"],
					messages: [userMessage("We added ci:test:smoke coverage this session.")],
					model,
					tools: [new WriteTool(session)],
				},
				streamFn: model.stream,
				getApiKey: () => "test-key",
				convertToLlm,
			},
		});

		// The loop wrote the file.
		const written = path.join(repo, ".omp", "knowledge", "workflows", "smoke-tests.md");
		expect(await Bun.file(written).text()).toContain("ci:test:smoke after worker changes");

		// It committed, and ONLY the knowledge subtree landed in the commit.
		expect(result).toMatchObject({ completed: true, committed: true });
		expect(result.sha).toBeDefined();
		const headAfter = await runGit(repo, ["rev-parse", "HEAD"]);
		expect(headAfter).not.toBe(headBefore);
		expect(headAfter.startsWith(result.sha as string)).toBe(true);
		const changed = (await runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]))
			.split("\n")
			.filter(Boolean);
		expect(changed).toEqual([".omp/knowledge/workflows/smoke-tests.md"]);

		// The model ran a real loop: one tool turn, then a turn-ending stop.
		expect(model.calls.length).toBe(2);
	});

	it("de-masks tool arguments so secrets persist RAW in .omp/knowledge", async () => {
		const dir = await tempDir("pi-knowledge-secret-");
		const secret = "correct-horse-battery-staple";
		const masker = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = masker.obfuscate(secret);
		// The masker must actually replace the secret, or the test proves nothing.
		expect(placeholder).not.toContain(secret);

		// The model only ever sees the masked placeholder (in context and in the
		// tool call it emits); the inbound transform must restore the real value
		// before the write tool persists it.
		const model = writeThenStopModel({
			path: "knowledge://infra/deploy.md",
			content: `---\ndescription: deploy token\n---\n\n# Deploy\n\n- token: ${placeholder}\n`,
		});
		const session = knowledgeToolSession(dir);

		const result = await runSessionKnowledgeAgent({
			cwd: dir,
			sourceTitle: "compaction session",
			instruction: "Update the project knowledge base from this session.",
			agent: {
				initialState: {
					systemPrompt: [masker.obfuscate(`Base prompt mentioning ${secret}`)],
					messages: [userMessage(masker.obfuscate(`The deploy token is ${secret}.`))],
					model,
					tools: [new WriteTool(session)],
				},
				streamFn: model.stream,
				getApiKey: () => "test-key",
				convertToLlm,
				transformToolCallArguments: args => masker.deobfuscateObject(args),
			},
		});

		const content = await Bun.file(path.join(dir, ".omp", "knowledge", "infra", "deploy.md")).text();
		expect(content).toContain(secret);
		expect(content).not.toContain(placeholder);
		// No git in this temp dir: the file is written but nothing is committed.
		expect(result).toMatchObject({ completed: true, committed: false });
	});

	it("does nothing when the signal is already aborted", async () => {
		const dir = await tempDir("pi-knowledge-abort-");
		const model = createMockModel({ responses: [] });
		const controller = new AbortController();
		controller.abort();

		const result = await runSessionKnowledgeAgent({
			cwd: dir,
			sourceTitle: "handoff session",
			instruction: "Update the project knowledge base from this session.",
			signal: controller.signal,
			agent: {
				initialState: { systemPrompt: ["Base prompt"], messages: [userMessage("hi")], model, tools: [] },
				streamFn: model.stream,
			},
		});

		expect(result).toEqual({ completed: false, committed: false });
		expect(model.calls.length).toBe(0);
	});

	it("reports an incomplete pass when the provider stream fails", async () => {
		const dir = await tempDir("pi-knowledge-provider-failure-");
		const model = createMockModel({
			responses: [{ throw: "provider unavailable" }],
		});

		const result = await runSessionKnowledgeAgent({
			cwd: dir,
			sourceTitle: "handoff session",
			instruction: "Update the project knowledge base from this session.",
			agent: {
				initialState: { systemPrompt: ["Base prompt"], messages: [userMessage("hi")], model, tools: [] },
				streamFn: model.stream,
			},
		});

		expect(result).toEqual({ completed: false, committed: false });
	});
	it("reports an incomplete pass when a tool returns an error before a normal stop", async () => {
		const dir = await tempDir("pi-knowledge-tool-failure-");
		const model = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "failed-write",
							name: "write",
							arguments: {
								path: "knowledge://workflows/failed.md",
								content: "",
							},
						},
					],
				},
				{ content: ["No knowledge changes needed."] },
			],
		});
		const session = knowledgeToolSession(dir);

		const result = await runSessionKnowledgeAgent({
			cwd: dir,
			sourceTitle: "handoff session",
			instruction: "Update the project knowledge base from this session.",
			agent: {
				initialState: {
					systemPrompt: ["Base prompt"],
					messages: [userMessage("hi")],
					model,
					tools: [new WriteTool(session)],
				},
				streamFn: model.stream,
				getApiKey: () => "test-key",
				convertToLlm,
			},
		});

		expect(result).toEqual({ completed: false, committed: false });
		expect(model.calls).toHaveLength(2);
		const failedResult = model.calls[1]?.context.messages.find(
			message => message.role === "toolResult" && message.toolCallId === "failed-write",
		);
		expect(failedResult).toMatchObject({ role: "toolResult", isError: true });
	});
});

describe("knowledge index description upgrades", () => {
	it("auto-upgrades prose knowledge descriptions with prompt-time retrieval tags", async () => {
		const dir = await tempDir("pi-knowledge-index-");
		const knowledgePath = path.join(dir, ".omp", "knowledge", "workflows", "smoke-tests.md");
		await Bun.write(
			knowledgePath,
			"---\ndescription: Run omp --smoke-test after binary worker changes.\n---\n\n# Smoke Tests\n\n- Run `omp --smoke-test` after binary worker changes.\n- Keep worker entries in build-binary.ts.\n",
		);

		const summaries = await loadKnowledgeSummaries({ cwd: dir });

		expect(summaries).toEqual([
			{
				category: "workflows",
				topic: "smoke-tests.md",
				path: "workflows/smoke-tests.md",
				description:
					"workflows, smoke tests, omp --smoke-test, binary worker changes, worker entries in build-binary.ts",
			},
		]);
		const upgraded = await Bun.file(knowledgePath).text();
		const { frontmatter, body } = parseFrontmatter(upgraded, { source: knowledgePath });
		expect(frontmatter.description).toBe(
			"workflows, smoke tests, omp --smoke-test, binary worker changes, worker entries in build-binary.ts",
		);
		expect(body).toBe(
			"# Smoke Tests\n\n- Run `omp --smoke-test` after binary worker changes.\n- Keep worker entries in build-binary.ts.",
		);
	});

	it("preserves dense tag descriptions in knowledge frontmatter", async () => {
		const dir = await tempDir("pi-knowledge-tags-");
		const knowledgePath = path.join(dir, ".omp", "knowledge", "infra", "regional-clusters.md");
		const description =
			"gs1, regional-clusters, ec-system, ec-phones, clusters.toml, phone_limit, task-deploy, task-kubectl, scripts/deploy.sh, UPDATE_ONLY, split-repos, gitea.minidev.space, Cargo-workspace, cloudphone.gg, Cloudflare-Tunnel, stream.<cluster>, PHONE_MEMORY_CAPACITY_MIB, ZFS-LocalPV, KubeVirt, virgl, Android-image, voyager-stable, CDI, ec_postboot.sh, simple-launcher, k3s, MetalLB, stream-webtransport";
		await Bun.write(knowledgePath, `---\ndescription: "${description}"\n---\n\n# Regional Clusters\n`);

		const summaries = await loadKnowledgeSummaries({ cwd: dir });

		expect(summaries).toEqual([
			{
				category: "infra",
				topic: "regional-clusters.md",
				path: "infra/regional-clusters.md",
				description,
			},
		]);
		const loaded = await Bun.file(knowledgePath).text();
		const { frontmatter } = parseFrontmatter(loaded, { source: knowledgePath });
		expect(frontmatter.description).toBe(description);
	});
});
