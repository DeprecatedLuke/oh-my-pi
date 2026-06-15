import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Message } from "@oh-my-pi/pi-ai/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { runSessionKnowledgeAgent } from "@oh-my-pi/pi-coding-agent/session/knowledge-base";
import { loadKnowledgeSummaries } from "@oh-my-pi/pi-coding-agent/session/knowledge-index";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolContextStore } from "@oh-my-pi/pi-coding-agent/tools/context";
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

		// The loop wrote the file (canWriteKnowledge was forced on for the pass).
		const written = path.join(repo, ".omp", "knowledge", "workflows", "smoke-tests.md");
		expect(await Bun.file(written).text()).toContain("ci:test:smoke after worker changes");

		// It committed, and ONLY the knowledge subtree landed in the commit.
		expect(result.committed).toBe(true);
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
		expect(result.committed).toBe(false);
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

		expect(result).toEqual({ committed: false });
		expect(model.calls.length).toBe(0);
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

describe("ToolContextStore knowledge-write gate", () => {
	it("keeps .omp/knowledge writes gated off until explicitly enabled", () => {
		// The compact subagent depends on this flag: the write/edit tools refuse
		// `.omp/knowledge` writes unless the store reports canWriteKnowledge true.
		// `createAgentSession` flips it on only when ExecutorOptions.canWriteKnowledge
		// is set, which only the internal knowledge-compact spawn does.
		const store = new ToolContextStore(() => ({}) as CustomToolContext);
		expect(store.getContext().canWriteKnowledge).toBe(false);

		store.setKnowledgeWritable(true);
		expect(store.getContext().canWriteKnowledge).toBe(true);

		store.setKnowledgeWritable(false);
		expect(store.getContext().canWriteKnowledge).toBe(false);
	});
});
