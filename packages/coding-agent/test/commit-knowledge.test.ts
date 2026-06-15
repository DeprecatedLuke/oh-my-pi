import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitKnowledgeFiles } from "../src/session/commit-knowledge";

const tempDirs: string[] = [];

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

/** Init a repo with a tracked file both inside and outside `.omp/knowledge`, committed once. */
async function initRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-knowledge-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "outside.txt"), "base\n");
	await fs.mkdir(path.join(repo, ".omp", "knowledge"), { recursive: true });
	await fs.writeFile(path.join(repo, ".omp", "knowledge", "note.md"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("commitKnowledgeFiles", () => {
	test("commits only the .omp/knowledge subtree, leaving other dirty files untouched", async () => {
		const repo = await initRepo();
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);

		// Dirty a file OUTSIDE .omp/knowledge and one INSIDE it.
		await fs.writeFile(path.join(repo, "outside.txt"), "dirty outside\n");
		await fs.writeFile(path.join(repo, ".omp", "knowledge", "note.md"), "updated knowledge\n");

		const result = await commitKnowledgeFiles(repo, { sourceTitle: "/knowledge compact" });

		expect(result.committed).toBe(true);
		expect(result.reason).toBeUndefined();

		// A new commit was created and the returned short SHA prefixes it.
		const headAfter = await runGit(repo, ["rev-parse", "HEAD"]);
		expect(headAfter).not.toBe(headBefore);
		expect(result.sha).toBeDefined();
		expect(headAfter.startsWith(result.sha as string)).toBe(true);

		// The commit touched ONLY the knowledge file.
		const changedFiles = (await runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]))
			.split("\n")
			.filter(Boolean);
		expect(changedFiles).toEqual([".omp/knowledge/note.md"]);

		// Subject line and the Source: body line from sourceTitle.
		expect(await runGit(repo, ["log", "-1", "--pretty=%s"])).toBe("chore(knowledge): update .omp/knowledge");
		expect((await runGit(repo, ["log", "-1", "--pretty=%b"])).trim()).toBe("Source: /knowledge compact");

		// The outside file remains modified in the worktree but was never staged or committed.
		expect((await runGit(repo, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)).toEqual([]);
		expect((await runGit(repo, ["diff", "--name-only"])).split("\n").filter(Boolean)).toEqual(["outside.txt"]);
	});

	test("returns reason 'clean' when the knowledge subtree has no changes", async () => {
		const repo = await initRepo();
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);
		// Dirty only OUTSIDE the knowledge subtree.
		await fs.writeFile(path.join(repo, "outside.txt"), "dirty outside\n");

		const result = await commitKnowledgeFiles(repo, {});

		expect(result).toEqual({ committed: false, reason: "clean" });
		// No commit was made and the outside change is left untouched.
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
		// Index stays empty (staging a clean subtree is a no-op); outside change is left modified and unstaged.
		expect((await runGit(repo, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)).toEqual([]);
		expect((await runGit(repo, ["diff", "--name-only"])).split("\n").filter(Boolean)).toEqual(["outside.txt"]);
	});

	test("returns reason 'no-git' outside any repository", async () => {
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-knowledge-nogit-"));
		tempDirs.push(plain);

		const result = await commitKnowledgeFiles(plain, {});

		expect(result).toEqual({ committed: false, reason: "no-git" });
	});
});
