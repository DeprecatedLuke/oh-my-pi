import * as path from "node:path";
import type { Subprocess } from "bun";
import { execCommand } from "../../core/exec";
import { WorktreeError, WorktreeErrorCode } from "./errors";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

type WritableLike = {
	write: (chunk: string | Uint8Array) => unknown;
	flush?: () => unknown;
	end?: () => unknown;
};

const textEncoder = new TextEncoder();

async function writeStdin(handle: unknown, stdin: string): Promise<void> {
	if (!handle || typeof handle === "number") return;
	if (typeof (handle as WritableStream<Uint8Array>).getWriter === "function") {
		const writer = (handle as WritableStream<Uint8Array>).getWriter();
		try {
			await writer.write(textEncoder.encode(stdin));
		} finally {
			await writer.close();
		}
		return;
	}

	const sink = handle as WritableLike;
	sink.write(stdin);
	if (sink.flush) sink.flush();
	if (sink.end) sink.end();
}

/**
 * Execute a git command.
 * @param args - Command arguments (excluding 'git')
 * @param cwd - Working directory (optional)
 * @returns Promise<GitResult>
 */
export async function git(args: string[], cwd?: string): Promise<GitResult> {
	const result = await execCommand("git", args, cwd ?? process.cwd());
	return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Execute git command with stdin input.
 * Used for piping diffs to `git apply`.
 */
export async function gitWithStdin(args: string[], stdin: string, cwd?: string): Promise<GitResult> {
	const proc: Subprocess = Bun.spawn(["git", ...args], {
		cwd: cwd ?? process.cwd(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStdin(proc.stdin, stdin);

	const [stdout, stderr, exitCode] = await Promise.all([
		(proc.stdout as ReadableStream<Uint8Array>).text(),
		(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);

	return { code: exitCode ?? 0, stdout, stderr };
}

/**
 * Get repository root directory.
 * @throws Error if not in a git repository
 */
export async function getRepoRoot(cwd?: string): Promise<string> {
	const result = await git(["rev-parse", "--show-toplevel"], cwd ?? process.cwd());
	if (result.code !== 0) {
		throw new WorktreeError("Not a git repository", WorktreeErrorCode.NOT_GIT_REPO);
	}
	const root = result.stdout.trim();
	if (!root) {
		throw new WorktreeError("Not a git repository", WorktreeErrorCode.NOT_GIT_REPO);
	}
	return path.resolve(root);
}

/**
 * Get repository name (directory basename of repo root).
 */
export async function getRepoName(cwd?: string): Promise<string> {
	const root = await getRepoRoot(cwd);
	return path.basename(root);
}
