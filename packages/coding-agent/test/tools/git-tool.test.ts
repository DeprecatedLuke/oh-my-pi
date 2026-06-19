import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import { GitTool } from "../../src/tools/git";
import * as commitMessageGenerator from "../../src/utils/commit-message-generator";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
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

async function createMonorepo(): Promise<{ root: string; nested: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tool-"));
	tempDirs.push(root);
	await initGitRepo(root);
	const nested = path.join(root, "packages", "lib");
	await initGitRepo(nested);
	return { root, nested };
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("GitTool", () => {
	it("reports root and unlinked nested repository status separately", async () => {
		const { root, nested } = await createMonorepo();
		await fs.writeFile(path.join(root, "tracked.txt"), "root edit\n");
		await fs.writeFile(path.join(nested, "tracked.txt"), "nested edit\n");

		const tool = new GitTool(createSession(root));
		const result = await tool.execute("call-status", { op: "status" });
		const details = result.details;
		if (details?.op !== "status") throw new Error("expected status details");

		expect(details.repos.map(repo => repo.label).sort()).toEqual([".", "packages/lib"]);
		const rootEntry = details.repos.find(repo => repo.label === ".");
		const nestedEntry = details.repos.find(repo => repo.label === "packages/lib");
		expect(rootEntry?.repoPath).toBe(root);
		expect(nestedEntry?.repoPath).toBe(nested);
		expect(rootEntry?.clean).toBe(false);
		expect(nestedEntry?.clean).toBe(false);
		expect(rootEntry?.files).toContain("tracked.txt");
		expect(nestedEntry?.files).toContain("tracked.txt");
	});

	it("checkpoints dirty root and nested repositories", async () => {
		const { root, nested } = await createMonorepo();
		await fs.writeFile(path.join(root, "tracked.txt"), "root edit\n");
		await fs.writeFile(path.join(nested, "tracked.txt"), "nested edit\n");
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("test: checkpoint changes");
		const session = createSession(root);
		// commitDirtyRepos only checks that a registry is present before delegating message
		// generation (mocked above), so a structural placeholder is sufficient here.
		(session as { modelRegistry?: unknown }).modelRegistry = {};

		const tool = new GitTool(session);
		const result = await tool.execute("call-checkpoint", { op: "checkpoint", reason: "test scope" });
		const details = result.details;
		if (details?.op !== "checkpoint") throw new Error("expected checkpoint details");

		expect(details.overallStatus).toBe("committed");
		expect(details.repos.map(repo => repo.label).sort()).toEqual([".", "packages/lib"]);
		expect(details.repos.every(repo => repo.status === "committed")).toBe(true);
		const statusAfter = await tool.execute("call-status-after", { op: "status" });
		const statusDetails = statusAfter.details;
		if (statusDetails?.op !== "status") throw new Error("expected status details");
		expect(statusDetails.repos.every(repo => repo.clean)).toBe(true);
		expect(await runGit(nested, ["status", "--porcelain=v1"])).toBe("");
		expect(await runGit(root, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		expect(await runGit(nested, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
	});

	it("checkpoints a root repo whose unlinked nested repo is gitignored", async () => {
		// Monorepo shape that previously broke checkpoint: the root `.gitignore`s its
		// unlinked nested repos. `excludeNestedPathspecs` used to name every discovered
		// nested repo in a `:(exclude)<path>` pathspec, and naming a gitignored path makes
		// `git add` die ("The following paths are ignored by one of your .gitignore files"),
		// failing the whole checkpoint. The gitignored nested repo must instead be left to
		// `git add -A`'s ignore handling while still being committed as its own repo.
		const { root, nested } = await createMonorepo();
		await fs.writeFile(path.join(root, ".gitignore"), "packages/lib\n");
		await runGit(root, ["add", ".gitignore"]);
		await runGit(root, ["commit", "-m", "ignore nested repo"]);
		await fs.writeFile(path.join(root, "tracked.txt"), "root edit\n");
		await fs.writeFile(path.join(nested, "tracked.txt"), "nested edit\n");
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("test: checkpoint changes");
		const session = createSession(root);
		(session as { modelRegistry?: unknown }).modelRegistry = {};

		const tool = new GitTool(session);
		const result = await tool.execute("call-checkpoint", { op: "checkpoint", reason: "test scope" });
		const details = result.details;
		if (details?.op !== "checkpoint") throw new Error("expected checkpoint details");

		// Both repos are iterated and committed — the gitignored nested repo is its own repo.
		expect(details.overallStatus).toBe("committed");
		expect(details.repos.map(repo => repo.label).sort()).toEqual([".", "packages/lib"]);
		expect(details.repos.every(repo => repo.status === "committed")).toBe(true);
		expect(await runGit(root, ["status", "--porcelain=v1"])).toBe("");
		expect(await runGit(root, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		expect(await runGit(nested, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		// The gitignored nested repo is never staged into the parent as an embedded gitlink.
		expect((await runGit(root, ["ls-files"])).split("\n")).not.toContain("packages/lib");
	});
});
