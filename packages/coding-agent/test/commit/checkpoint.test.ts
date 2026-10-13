import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { commitCheckpointRepos, dirtyRepos, selectDirtyRepos } from "../../src/commit/checkpoint";
import * as commitMessageGenerator from "../../src/utils/commit-message-generator";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`);
	}
	return stdout.trim();
}

async function initGitRepo(repo: string): Promise<void> {
	await fs.mkdir(repo, { recursive: true });
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
}

/** Root repo with an unlinked nested repo at packages/lib, both dirty. */
async function createDirtyMonorepo(): Promise<{ root: string; nested: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-checkpoint-"));
	tempDirs.push(root);
	await initGitRepo(root);
	const nested = path.join(root, "packages", "lib");
	await initGitRepo(nested);
	await fs.writeFile(path.join(root, "tracked.txt"), "root edit\n");
	await fs.writeFile(path.join(nested, "tracked.txt"), "nested edit\n");
	return { root, nested };
}

function commitOptions(cwd: string) {
	vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("test: checkpoint changes");
	// Message generation is mocked, so the registry is never consulted.
	return { cwd, modelRegistry: {} as ModelRegistry, settings: Settings.isolated() };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("git checkpoint", () => {
	it("lists root and unlinked nested repos separately, without counting the child in the parent", async () => {
		const { root, nested } = await createDirtyMonorepo();

		const dirty = await dirtyRepos(root);

		expect(dirty.map(repo => [repo.label, repo.repoPath, repo.changedFiles])).toEqual([
			[".", root, 1],
			["packages/lib", nested, 1],
		]);
	});

	it("matches repos by listed label or by path and reports names that match no dirty repo", async () => {
		const { root, nested } = await createDirtyMonorepo();
		const dirty = await dirtyRepos(root);

		const byLabel = selectDirtyRepos(root, dirty, ["packages/lib", "missing"]);
		expect(byLabel.selected.map(repo => repo.repoPath)).toEqual([nested]);
		expect(byLabel.unmatched).toEqual(["missing"]);

		const byPath = selectDirtyRepos(path.join(root, "packages"), dirty, ["lib/", ".."]);
		expect(byPath.selected.map(repo => repo.repoPath)).toEqual([nested, root]);
		expect(byPath.unmatched).toEqual([]);
	});

	it("commits only the selected repo and leaves other dirty repos untouched", async () => {
		const { root, nested } = await createDirtyMonorepo();
		const dirty = await dirtyRepos(root);
		const { selected } = selectDirtyRepos(root, dirty, ["packages/lib"]);

		const entries = await commitCheckpointRepos(selected, commitOptions(root));

		expect(entries.map(entry => [entry.label, entry.status])).toEqual([["packages/lib", "committed"]]);
		expect(await runGit(nested, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		expect(await runGit(root, ["log", "-1", "--format=%s"])).toBe("initial");
		expect((await dirtyRepos(root)).map(repo => repo.label)).toEqual(["."]);
	});

	it("commits a root repo whose unlinked nested repo is gitignored", async () => {
		// Regression: naming a gitignored nested repo in a `:(exclude)` pathspec makes
		// `git add` die ("The following paths are ignored by one of your .gitignore files").
		const { root, nested } = await createDirtyMonorepo();
		await fs.writeFile(path.join(root, ".gitignore"), "packages/lib\n");
		await runGit(root, ["add", ".gitignore"]);
		await runGit(root, ["commit", "-m", "ignore nested repo"]);
		await fs.writeFile(path.join(root, "tracked.txt"), "root edit again\n");

		const entries = await commitCheckpointRepos(await dirtyRepos(root), commitOptions(root));

		expect(entries.map(entry => [entry.label, entry.status])).toEqual([
			[".", "committed"],
			["packages/lib", "committed"],
		]);
		expect(await runGit(root, ["status", "--porcelain=v1"])).toBe("");
		expect(await runGit(nested, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		// The gitignored nested repo is never staged into the parent as an embedded gitlink.
		expect((await runGit(root, ["ls-files"])).split("\n")).not.toContain("packages/lib");
	});
});
