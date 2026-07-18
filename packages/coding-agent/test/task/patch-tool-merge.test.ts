/**
 * Contract: the `task.isolation.merge: "patch-tool"` strategy.
 *
 * Isolated subagent edits are captured into the native patch store and either
 * auto-applied to a clean target repo (committed, status "applied") or, when the
 * target repo is dirty, left as a durable `patch://` for manual apply (status
 * "pending"). This defends the wiring between the isolation pipeline and the
 * proprietary native patch system — distinct from `native-patches.test.ts`,
 * which exercises the patch primitives in isolation.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed (${exitCode})`);
	}
	return stdout.trim();
}

async function createRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-tool-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

const editAgent: AgentDefinition = {
	name: "task",
	description: "Edit-capable agent",
	systemPrompt: "You edit files.",
	source: "bundled",
};

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "rcopy",
			"task.isolation.merge": "patch-tool",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Add a file.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(p => p.type === "text");
	return part?.type === "text" ? (part.text ?? "") : "";
}

/** Stub the subagent: write `added.txt` into the isolation worktree, succeed. */
function stubSubprocessWritingFile(): void {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const worktree = options.worktree;
		if (!worktree) throw new Error("expected an isolation worktree for patch-tool mode");
		await fs.writeFile(path.join(worktree, "added.txt"), "from subagent\n");
		return makeResult(options.id ?? "?");
	});
}

/** Stub the subagent: write `added.txt` into the worktree, then report aborted. */
function stubSubprocessAbortedWithFile(): void {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const worktree = options.worktree;
		if (!worktree) throw new Error("expected an isolation worktree for patch-tool mode");
		await fs.writeFile(path.join(worktree, "added.txt"), "from aborted subagent\n");
		return { ...makeResult(options.id ?? "?"), aborted: true };
	});
}

/** Stub the subagent: change nothing in the worktree, then report aborted. */
function stubSubprocessAbortedNoChanges(): void {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		if (!options.worktree) throw new Error("expected an isolation worktree for patch-tool mode");
		return { ...makeResult(options.id ?? "?"), aborted: true };
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("patch-tool merge strategy", () => {
	it("captures isolated edits as a native patch and auto-applies them to a clean repo", async () => {
		const repo = await createRepo();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [editAgent], projectAgentsDir: null });
		stubSubprocessWritingFile();

		const tool = await TaskTool.create(createSession(repo));
		const result = await tool.execute("tc-clean", {
			agent: "task",
			name: "Patcher",
			task: "Add a file.",
			isolated: true,
		} as TaskParams);

		// Edit landed in the real target repo (applied, not just captured).
		expect(await fs.readFile(path.join(repo, "added.txt"), "utf8")).toBe("from subagent\n");
		// Auto-apply committed it: the working tree is clean afterward.
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");

		const patch = result.details?.results[0]?.patches?.[0];
		expect(patch?.status).toBe("applied");
		expect(patch?.uri).toMatch(/^patch:\/\//);
		expect(firstText(result)).toContain("automatically applied");
	});

	it("leaves a pending patch:// when the target repo is dirty", async () => {
		const repo = await createRepo();
		// Dirty the target so auto-apply must refuse and surface the patch instead.
		await fs.writeFile(path.join(repo, "seed.txt"), "seed dirty\n");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [editAgent], projectAgentsDir: null });
		stubSubprocessWritingFile();

		const tool = await TaskTool.create(createSession(repo));
		const result = await tool.execute("tc-dirty", {
			agent: "task",
			name: "Patcher",
			task: "Add a file.",
			isolated: true,
		} as TaskParams);

		// The subagent's edit was NOT applied to the dirty target repo.
		const applied = await fs
			.access(path.join(repo, "added.txt"))
			.then(() => true)
			.catch(() => false);
		expect(applied).toBe(false);

		const patch = result.details?.results[0]?.patches?.[0];
		expect(patch?.status).toBe("pending");
		expect(patch?.uri).toMatch(/^patch:\/\//);
		expect(result.details?.results[0]?.error).toContain("dirty");
		expect(firstText(result)).toContain("pending patches");
	});

	it("captures aborted-task edits as a recovery patch instead of applying them", async () => {
		const repo = await createRepo();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [editAgent], projectAgentsDir: null });
		stubSubprocessAbortedWithFile();

		const tool = await TaskTool.create(createSession(repo));
		const result = await tool.execute("tc-abort", {
			agent: "task",
			name: "Patcher",
			task: "Add a file.",
			isolated: true,
		} as TaskParams);

		// Aborted work is NOT applied to the (clean) target repo...
		const applied = await fs
			.access(path.join(repo, "added.txt"))
			.then(() => true)
			.catch(() => false);
		expect(applied).toBe(false);
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");

		// ...it is preserved as a durable, unapplied recovery patch instead.
		const single = result.details?.results[0];
		expect(single?.recoveryCaptureStatus).toBe("preserved");
		const patch = single?.patches?.[0];
		expect(patch?.recovery).toBe(true);
		expect(patch?.status).toBe("pending");
		expect(patch?.uri).toMatch(/^patch:\/\//);
		// A recovery patch is not an apply failure: it must not populate `error`.
		expect(single?.error).toBeUndefined();
		expect(firstText(result)).toContain("preserved aborted task edits");
	});

	it("reports an empty recovery when an aborted task changed nothing", async () => {
		const repo = await createRepo();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [editAgent], projectAgentsDir: null });
		stubSubprocessAbortedNoChanges();

		const tool = await TaskTool.create(createSession(repo));
		const result = await tool.execute("tc-abort-empty", {
			agent: "task",
			name: "Patcher",
			task: "Add a file.",
			isolated: true,
		} as TaskParams);

		const single = result.details?.results[0];
		expect(single?.recoveryCaptureStatus).toBe("empty");
		expect(single?.patches).toBeUndefined();
		expect(firstText(result)).toContain("no recovery patch");
	});
});
