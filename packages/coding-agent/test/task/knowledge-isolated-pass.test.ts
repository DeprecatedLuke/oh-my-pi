/**
 * Contract: `runIsolatedKnowledgePass` — knowledge maintenance runs in an
 * isolated worktree and emits a native patch instead of writing+committing the
 * real tree directly.
 *
 * Guarantees defended here (the new isolation wiring; the underlying
 * dirty-check/apply path is separately guarded by patch-tool-merge.test.ts):
 *  - clean repo → patch auto-applies + commits (status "applied");
 *  - capture is SCOPED to `.omp/knowledge` — a stray write outside the subtree
 *    never rides along into the auto-applied patch;
 *  - dirty repo → patch left pending (status "pending"), nothing applied;
 *  - aborted pass → edits captured as an unapplied recovery patch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runIsolatedKnowledgePass } from "@oh-my-pi/pi-coding-agent/task";

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
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-knowledge-pass-"));
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

async function writeKnowledge(worktree: string, rel: string, content: string): Promise<void> {
	const target = path.join(worktree, ".omp", "knowledge", rel);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

async function exists(p: string): Promise<boolean> {
	return fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runIsolatedKnowledgePass", () => {
	it("auto-applies the knowledge patch to a clean repo and commits it", async () => {
		const repo = await createRepo();
		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: async () => "chore(knowledge): update .omp/knowledge",
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.exitCode).toBe(0);
		expect(pass.patches[0]?.status).toBe("applied");
		// The note landed in the REAL repo and the auto-apply committed it.
		expect(await fs.readFile(path.join(repo, ".omp", "knowledge", "repo", "layout.md"), "utf8")).toBe("# layout\n");
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
		expect(pass.summary).toContain("automatically applied");
	});

	it("scopes the patch to .omp/knowledge — a stray write outside the subtree never rides along", async () => {
		const repo = await createRepo();
		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: async () => "chore(knowledge): update .omp/knowledge",
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				// A stray side-effect outside the knowledge subtree (e.g. via bash).
				await fs.writeFile(path.join(worktree, "stray.txt"), "should not be captured\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.patches[0]?.status).toBe("applied");
		// The knowledge note is applied...
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(true);
		// ...but the out-of-subtree write is NOT in the patch and never reaches the real repo.
		expect(await exists(path.join(repo, "stray.txt"))).toBe(false);
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
	});

	it("leaves a pending patch when the target repo is dirty (no auto-commit)", async () => {
		const repo = await createRepo();
		// Dirty the target so auto-apply must refuse.
		await fs.writeFile(path.join(repo, "seed.txt"), "seed dirty\n");
		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeUpdate",
			description: "Update the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: async () => "chore(knowledge): update .omp/knowledge",
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.patches[0]?.status).toBe("pending");
		expect(pass.patches[0]?.uri).toMatch(/^patch:\/\//);
		// Nothing applied to the dirty repo.
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(false);
		expect(pass.summary).toContain("pending patches");
	});

	it("captures aborted-pass edits as an unapplied recovery patch", async () => {
		const repo = await createRepo();
		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: async () => "chore(knowledge): update .omp/knowledge",
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: true };
			},
		});

		expect(pass.aborted).toBe(true);
		expect(pass.patches[0]?.recovery).toBe(true);
		expect(pass.patches[0]?.status).toBe("pending");
		// Aborted edits are preserved, not applied.
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(false);
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
	});
});
