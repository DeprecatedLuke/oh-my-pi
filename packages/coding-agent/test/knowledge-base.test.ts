import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { writeSessionKnowledge } from "@oh-my-pi/pi-coding-agent/session/knowledge-base";
import { loadKnowledgeSummaries } from "@oh-my-pi/pi-coding-agent/session/knowledge-index";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createKnowledgeToolMessage(files: Array<{ path: string; content: string }>): AssistantMessage {
	const base = createAssistantMessage("");
	return {
		...base,
		content: [{ type: "toolCall", id: "call_knowledge", name: "save_knowledge", arguments: { files } }],
		stopReason: "toolUse",
	};
}

function createErrorMessage(errorMessage: string): AssistantMessage {
	const base = createAssistantMessage("");
	return { ...base, content: [], stopReason: "error", errorMessage };
}

describe("session knowledge base", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("updates an existing category instead of duplicating knowledge", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-"));
		try {
			const existingPath = path.join(dir, ".omp", "knowledge", "workflows", "smoke-tests.md");
			await Bun.write(existingPath, "# Smoke Tests\n\n- Run `omp --smoke-test` after binary worker changes.\n");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");

			const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(
				createKnowledgeToolMessage([
					{
						path: "workflows/smoke-tests.md",
						content:
							"# Smoke Tests\n\n- Run `omp --smoke-test` after binary worker changes.\n- Run `ci:test:smoke` for source-link and tarball install smoke coverage.\n",
					},
				]),
			);

			const sessionMessages: Message[] = [
				{ role: "user", content: [{ type: "text", text: "Need smoke coverage notes" }], timestamp: Date.now() - 1 },
				createAssistantMessage("ci:test:smoke covers source-link and tarball install smoke paths."),
			];

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "handoff session",
				messages: sessionMessages,
			});

			expect(result?.written).toEqual(["workflows/smoke-tests.md"]);
			const updatedKnowledge = await Bun.file(existingPath).text();
			const { frontmatter: updatedFrontmatter } = parseFrontmatter(updatedKnowledge, { source: existingPath });
			expect(updatedKnowledge).toContain("ci:test:smoke");
			expect(updatedFrontmatter.description).toBe(
				"workflows, smoke tests, omp --smoke-test, binary worker changes, ci:test:smoke, source-link and tarball install smoke coverage",
			);
			expect(completeSpy).toHaveBeenCalledTimes(1);
			const context = completeSpy.mock.calls[0]?.[1];
			expect(context?.systemPrompt).toEqual(["Base prompt"]);
			expect(context?.messages.slice(0, -1)).toEqual(sessionMessages);
			const promptContent = context?.messages[context.messages.length - 1]?.content;
			const promptBlock = Array.isArray(promptContent) ? promptContent[0] : undefined;
			const promptText =
				promptBlock && typeof promptBlock === "object" && promptBlock.type === "text" ? promptBlock.text : "";
			expect(context?.messages.at(-1)?.role).toBe("developer");
			expect(promptText).toContain('<file path="workflows/smoke-tests.md">');
			expect(promptText).toContain("Prefer updating an existing category/topic file");
			expect(promptText).toContain("MUST be tag-based");
			const callOptions = completeSpy.mock.calls[0]?.[2];
			expect(callOptions?.toolChoice).toEqual({ type: "tool", name: "save_knowledge" });
			expect(callOptions?.maxTokens).toBeUndefined();
			expect(context?.tools?.some(tool => tool.name === "save_knowledge")).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("creates project .omp/knowledge when writing new durable knowledge", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-create-"));
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(
				createKnowledgeToolMessage([
					{
						path: "runtime/background-jobs.md",
						content: "# Background Jobs\n\n- Completion deliveries are suppressed during handoff.\n",
					},
				]),
			);

			const sessionMessages: Message[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Completion deliveries are suppressed during handoff." }],
					timestamp: Date.now() - 1,
				},
			];

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "compaction session",
				messages: sessionMessages,
			});

			expect(result?.written).toEqual(["runtime/background-jobs.md"]);
			expect(completeSpy).toHaveBeenCalledTimes(1);
			const context = completeSpy.mock.calls[0]?.[1];
			expect(context?.messages.slice(0, -1)).toEqual(sessionMessages);
			const promptContent = context?.messages[context.messages.length - 1]?.content;
			const promptBlock = Array.isArray(promptContent) ? promptContent[0] : undefined;
			const promptText =
				promptBlock && typeof promptBlock === "object" && promptBlock.type === "text" ? promptBlock.text : "";
			expect(context?.messages.at(-1)?.role).toBe("developer");
			expect(promptText).toContain("No existing knowledge files.");
			const writtenKnowledgePath = path.join(dir, ".omp", "knowledge", "runtime", "background-jobs.md");
			const writtenKnowledge = await Bun.file(writtenKnowledgePath).text();
			const { frontmatter, body } = parseFrontmatter(writtenKnowledge, { source: writtenKnowledgePath });
			expect(frontmatter.description).toBe("runtime, background jobs, Completion deliveries, handoff");
			expect(body).toBe("# Background Jobs\n\n- Completion deliveries are suppressed during handoff.");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("auto-upgrades prose knowledge descriptions with prompt-time retrieval tags", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-index-"));
		try {
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
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves dense tag descriptions in knowledge frontmatter", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-tags-"));
		try {
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
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("uses the lowest supported reasoning effort for extraction models", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-reasoning-"));
		try {
			const model = getBundledModel("openai-codex", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model");
			const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createKnowledgeToolMessage([]));

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "handoff session",
				messages: [
					{ role: "user", content: [{ type: "text", text: "Remember this durable fact." }], timestamp: 1 },
				],
			});

			expect(result).toEqual({ written: [], skipped: 0 });
			expect(completeSpy).toHaveBeenCalledTimes(1);
			expect(completeSpy.mock.calls[0]?.[2]?.reasoning).toBe(ai.Effort.Low);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retries a failed extraction before succeeding", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-retry-"));
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const completeSpy = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValueOnce(createErrorMessage("upstream 529"))
				.mockResolvedValueOnce(
					createKnowledgeToolMessage([
						{ path: "runtime/retry.md", content: "# Retry\n\n- Extraction retried after a transient error.\n" },
					]),
				);

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "auto-compaction session",
				messages: [{ role: "user", content: [{ type: "text", text: "Durable retry fact." }], timestamp: 1 }],
			});

			expect(completeSpy).toHaveBeenCalledTimes(2);
			expect(result?.written).toEqual(["runtime/retry.md"]);
			expect(await Bun.file(path.join(dir, ".omp", "knowledge", "runtime", "retry.md")).text()).toContain("Retry");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined when every extraction attempt fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-fail-"));
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createErrorMessage("upstream 529"));

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "auto-compaction session",
				messages: [{ role: "user", content: [{ type: "text", text: "Durable fact." }], timestamp: 1 }],
			});

			expect(result).toBeUndefined();
			expect(completeSpy).toHaveBeenCalledTimes(3);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("salvages files from a prose response when the tool call is downgraded", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-knowledge-prose-"));
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			vi.spyOn(ai, "completeSimple").mockResolvedValue(
				createAssistantMessage(
					`Here is the knowledge:\n${JSON.stringify({ files: [{ path: "runtime/prose.md", content: "# Prose\n\n- Recovered from text.\n" }] })}`,
				),
			);

			const result = await writeSessionKnowledge({
				cwd: dir,
				model,
				apiKey: "test-key",
				baseSystemPrompt: ["Base prompt"],
				sourceTitle: "handoff session",
				messages: [{ role: "user", content: [{ type: "text", text: "Durable prose fact." }], timestamp: 1 }],
			});

			expect(result?.written).toEqual(["runtime/prose.md"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
