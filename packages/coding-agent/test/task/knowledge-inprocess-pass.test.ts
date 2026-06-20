/**
 * Contract: `runInProcessKnowledgePatchPass` — the background session distill
 * writes the REAL `.omp/knowledge` (it needs the parent's live tools/history,
 * so it can't run in a worktree), but its edits are captured as a native patch
 * and the working tree is reverted, instead of being left committed.
 *
 * Invariants defended here (the new snapshot/revert wiring; the underlying
 * dirty-check/apply path is guarded by patch-tool-merge.test.ts):
 *  - clean repo → patch auto-applies + commits, and the distill's intermediate
 *    writes do not linger (tree clean afterward);
 *  - dirty repo → patch left pending, the distill's edits are reverted (NOT
 *    applied), and the pre-existing dirty edits are preserved;
 *  - build-from-scratch (no `.omp/knowledge` at all) → captured as adds;
 *  - a throwing distill still reverts the real tree (no leaked edits).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInProcessKnowledgePatchPass } from "@oh-my-pi/pi-coding-agent/task";

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

async function createRepo(seedKnowledge?: { rel: string; content: string }): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-knowledge-inproc-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
	if (seedKnowledge) {
		await writeKnowledge(repo, seedKnowledge.rel, seedKnowledge.content);
	}
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

async function writeKnowledge(repo: string, rel: string, content: string): Promise<void> {
	const target = path.join(repo, ".omp", "knowledge", rel);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

async function readKnowledge(repo: string, rel: string): Promise<string | null> {
	return fs.readFile(path.join(repo, ".omp", "knowledge", rel), "utf8").catch(() => null);
}

const noopMessage = async () => "chore(knowledge): update .omp/knowledge";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runInProcessKnowledgePatchPass", () => {
	it("captures the distill's edits as an applied patch on a clean repo and leaves no lingering writes", async () => {
		const repo = await createRepo({ rel: "repo/layout.md", content: "old\n" });
		const pass = await runInProcessKnowledgePatchPass({
			cwd: repo,
			taskId: "KnowledgeDistill",
			description: "compaction session",
			generateMessage: noopMessage,
			runDistill: async () => {
				// The distill writes the REAL tree (as the in-process agent would).
				await writeKnowledge(repo, "repo/layout.md", "new\n");
				await writeKnowledge(repo, "repo/new-note.md", "fresh\n");
			},
		});

		expect(pass.patches[0]?.status).toBe("applied");
		// The committed patch carries the distilled content...
		expect(await readKnowledge(repo, "repo/layout.md")).toBe("new\n");
		expect(await readKnowledge(repo, "repo/new-note.md")).toBe("fresh\n");
		// ...and the auto-apply committed it, so the tree is clean (no lingering
		// uncommitted distill writes).
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
	});

	it("reverts the distill's edits and leaves a pending patch when the repo is dirty", async () => {
		const repo = await createRepo({ rel: "repo/layout.md", content: "committed\n" });
		// Pre-existing uncommitted edit elsewhere makes the repo dirty.
		await fs.writeFile(path.join(repo, "seed.txt"), "user edit\n");

		const pass = await runInProcessKnowledgePatchPass({
			cwd: repo,
			taskId: "KnowledgeDistill",
			description: "compaction session",
			generateMessage: noopMessage,
			runDistill: async () => {
				await writeKnowledge(repo, "repo/layout.md", "distilled\n");
			},
		});

		expect(pass.patches[0]?.status).toBe("pending");
		expect(pass.patches[0]?.uri).toMatch(/^patch:\/\//);
		// The distill's edit was reverted — the knowledge file is back to baseline.
		expect(await readKnowledge(repo, "repo/layout.md")).toBe("committed\n");
		// The user's pre-existing dirty edit is preserved untouched.
		expect(await fs.readFile(path.join(repo, "seed.txt"), "utf8")).toBe("user edit\n");
	});

	it("captures a from-scratch build (no prior .omp/knowledge) as adds", async () => {
		const repo = await createRepo();
		expect(await readKnowledge(repo, "repo/layout.md")).toBeNull();

		const pass = await runInProcessKnowledgePatchPass({
			cwd: repo,
			taskId: "KnowledgeDistill",
			description: "compaction session",
			generateMessage: noopMessage,
			runDistill: async () => {
				await writeKnowledge(repo, "repo/layout.md", "authored\n");
			},
		});

		expect(pass.patches[0]?.status).toBe("applied");
		expect(await readKnowledge(repo, "repo/layout.md")).toBe("authored\n");
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
	});

	it("reverts the real tree even when the distill throws", async () => {
		const repo = await createRepo({ rel: "repo/layout.md", content: "committed\n" });

		await expect(
			runInProcessKnowledgePatchPass({
				cwd: repo,
				taskId: "KnowledgeDistill",
				description: "compaction session",
				generateMessage: noopMessage,
				runDistill: async () => {
					// Write then fail — the half-written edit must not linger.
					await writeKnowledge(repo, "repo/layout.md", "half-written\n");
					throw new Error("distill blew up");
				},
			}),
		).rejects.toThrow("distill blew up");

		// The real tree is restored to baseline despite the throw.
		expect(await readKnowledge(repo, "repo/layout.md")).toBe("committed\n");
		expect(await runGit(repo, ["status", "--porcelain"])).toBe("");
	});
});
