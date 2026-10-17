/**
 * `git_checkpoint` tool contract tests: the two-stage flow against a real temp git
 * repo, and the CLI's exact stdout/exit codes for the two stages that never need a
 * model (the shared stage function must keep `omp git checkpoint` byte-identical).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GitCheckpointTool, type GitCheckpointToolDetails } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "../../src/tools";
import * as commitMessageGenerator from "../../src/utils/commit-message-generator";

const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli.ts");
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

/** Dirty single-repo workspace: one tracked edit, HEAD at the initial commit. */
async function createDirtyRepo(): Promise<{ repo: string; head: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-checkpoint-tool-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "edit\n");
	return { repo, head: await runGit(repo, ["rev-parse", "HEAD"]) };
}

function createSession(cwd: string, registry?: ModelRegistry): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: registry,
		getSessionId: () => "test-session",
	};
}

function makeTool(cwd: string, registry?: ModelRegistry): GitCheckpointTool {
	const tool = GitCheckpointTool.createIf(createSession(cwd, registry));
	if (!tool) throw new Error("git_checkpoint tool should always be available");
	return tool;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("git_checkpoint tool", () => {
	it("stage one lists the dirty repo and commits nothing", async () => {
		const { repo, head } = await createDirtyRepo();
		const tool = makeTool(repo);

		for (const params of [{}, { repos: [] }]) {
			const result = await tool.execute("tc-list", params);
			const details = result.details as GitCheckpointToolDetails;

			expect(details.stage).toBe("listed");
			expect(details.dirty.map(entry => [entry.label, entry.changedFiles])).toEqual([[".", 1]]);
			expect(textOf(result)).toContain("Detected repos with changes:\n  . (1 file)");
			// Listing is not a failure, and it must not have touched history.
			expect(result.isError).toBeUndefined();
			expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
		}
	});

	it("stage two rejects an unknown name and commits nothing", async () => {
		const { repo, head } = await createDirtyRepo();
		const tool = makeTool(repo);

		const result = await tool.execute("tc-unmatched", { repos: ["packages/lib"] });
		const details = result.details as GitCheckpointToolDetails;

		expect(details.stage).toBe("unmatched");
		expect(details.unmatched).toEqual(["packages/lib"]);
		expect(textOf(result)).toContain("No dirty repo matches: packages/lib");
		expect(textOf(result)).toContain("  . (1 file)");
		expect(result.isError).toBe(true);
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("stage two commits the repo named exactly as listed", async () => {
		const { repo, head } = await createDirtyRepo();
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("test: checkpoint changes");
		// Message generation is mocked, so the registry is never consulted.
		const tool = makeTool(repo, {} as ModelRegistry);

		const result = await tool.execute("tc-commit", { repos: ["."] });
		const details = result.details as GitCheckpointToolDetails;
		const entry = details.entries?.[0];

		expect(details.stage).toBe("committed");
		expect(entry).toMatchObject({
			label: ".",
			status: "committed",
			filesChanged: 1,
			message: "test: checkpoint changes",
		});
		expect(entry?.sha).toBeTruthy();
		expect(result.isError).toBeUndefined();
		expect(await runGit(repo, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		expect(await runGit(repo, ["rev-parse", "HEAD"])).not.toBe(head);
	});

	it("surfaces a failed commit as a tool error without advancing history", async () => {
		const { repo, head } = await createDirtyRepo();
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("");
		const tool = makeTool(repo, {} as ModelRegistry);

		const result = await tool.execute("tc-failed", { repos: ["."] });
		const details = result.details as GitCheckpointToolDetails;

		expect(details.entries?.map(entry => entry.status)).toEqual(["failed"]);
		expect(result.isError).toBe(true);
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("reports a clean workspace as nothing to commit", async () => {
		const { repo } = await createDirtyRepo();
		await runGit(repo, ["commit", "-am", "edit"]);
		const tool = makeTool(repo);

		const result = await tool.execute("tc-clean", {});

		expect((result.details as GitCheckpointToolDetails).stage).toBe("clean");
		expect(textOf(result)).toContain("Nothing to commit — all repos are clean.");
	});
});

describe("omp git checkpoint", () => {
	async function runCli(repo: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn([process.execPath, CLI_ENTRY, "git", "checkpoint", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	}

	it("lists dirty repos with unchanged output and exit code", async () => {
		const { repo, head } = await createDirtyRepo();

		const { exitCode, stdout, stderr } = await runCli(repo, []);

		expect(exitCode).toBe(0);
		expect(stdout).toBe(
			"Detected repos with changes:\n  . (1 file)\n\nCommit only the repos you are responsible for: omp git checkpoint <repo>...\n",
		);
		expect(stderr).toBe("");
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("refuses an unknown name with unchanged output and exit code", async () => {
		const { repo, head } = await createDirtyRepo();

		const { exitCode, stdout, stderr } = await runCli(repo, ["nope"]);

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toBe("No dirty repo matches: nope\nDetected repos with changes:\n  . (1 file)\n");
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});
});
