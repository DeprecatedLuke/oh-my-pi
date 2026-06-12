import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { detectGitRepos, formatRepoLabel } from "../patches";
import gitDescription from "../prompts/tools/git.md" with { type: "text" };
import { type CommitDirtyRepoEntry, commitDirtyRepos } from "../task/auto-commit";
import * as git from "../utils/git";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const gitSchema = z.object({
	op: z.enum(["checkpoint", "status"]).describe("operation to perform"),
	reason: z
		.string()
		.optional()
		.describe(
			"Short label for a checkpoint scope, e.g. 'after login refactor'. Used only for agent bookkeeping and surfaced in the transcript; it is not written into the commit message.",
		),
});

export type GitToolParams = z.infer<typeof gitSchema>;

export type GitCheckpointRepoEntry = CommitDirtyRepoEntry & { label: string };

export interface GitCheckpointDetails {
	op: "checkpoint";
	overallStatus: "committed" | "clean" | "partial" | "failed";
	reason?: string;
	repos: GitCheckpointRepoEntry[];
	meta?: OutputMeta;
}

export interface GitStatusRepoEntry {
	repoPath: string;
	label: string;
	clean: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	files: string[];
}

export interface GitStatusDetails {
	op: "status";
	root: string;
	repos: GitStatusRepoEntry[];
	meta?: OutputMeta;
}

export type GitToolDetails = GitCheckpointDetails | GitStatusDetails;

const STATUS_FILE_LIMIT = 8;

type PorcelainEntry = {
	path: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
};

export class GitTool implements AgentTool<typeof gitSchema, GitToolDetails> {
	readonly name = "git";
	readonly approval = (args: unknown) => {
		const op = (args as Partial<GitToolParams>).op;
		return op === "status" ? "read" : "write";
	};
	readonly label = "Git";
	readonly summary = "Inspect git status or create local WIP checkpoint commits";
	readonly description: string;
	readonly parameters = gitSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<GitToolParams>) => {
		if (args.op === "status") return "checking git status";
		return args.reason ? `checkpointing git: ${args.reason}` : "checkpointing git";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(gitDescription);
	}

	static async createIf(session: ToolSession): Promise<GitTool | null> {
		if ((session.taskDepth ?? 0) !== 0) return null;
		try {
			const detected = await detectGitRepos(session.cwd);
			if (!detected || detected.repos.length === 0) return null;
			return new GitTool(session);
		} catch {
			return null;
		}
	}

	async execute(
		_toolCallId: string,
		params: GitToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GitToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GitToolDetails>> {
		return untilAborted(signal, async () => {
			if (params.op === "status") {
				return executeGitStatus(this.session, signal);
			}
			if (params.op === "checkpoint") {
				return executeGitCheckpoint(this.session, params.reason);
			}
			throw new ToolError(`Unsupported git op: ${(params as { op?: string }).op ?? "(missing)"}`);
		});
	}
}

export async function executeGitCheckpoint(
	session: ToolSession,
	reason: string | undefined,
): Promise<AgentToolResult<GitCheckpointDetails>> {
	const cwd = session.cwd;
	const entries = await commitDirtyRepos({
		cwd,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		sessionId: session.getSessionId?.() ?? undefined,
	});

	if (entries.length === 0) {
		const details: GitCheckpointDetails = {
			op: "checkpoint",
			overallStatus: "clean",
			reason,
			repos: [],
		};
		return toolResult<GitCheckpointDetails>(details)
			.text(`Nothing to commit — all repos under ${formatRepoLabel(session.cwd, cwd)} are clean.`)
			.done();
	}
	const repos = entries.map(entry => ({
		...entry,
		label: formatRepoLabel(session.cwd, entry.repoPath),
	}));
	const committed = repos.filter(entry => entry.status === "committed").length;
	const failed = repos.filter(entry => entry.status === "failed").length;
	const overallStatus: GitCheckpointDetails["overallStatus"] =
		failed === repos.length ? "failed" : failed > 0 ? "partial" : committed === 0 ? "clean" : "committed";

	const details: GitCheckpointDetails = {
		op: "checkpoint",
		overallStatus,
		reason,
		repos,
	};
	const text = formatGitCheckpointResultText(session, repos);
	if (overallStatus === "failed") {
		throw new ToolError(text);
	}
	return toolResult<GitCheckpointDetails>(details).text(text).done();
}

async function executeGitStatus(
	session: ToolSession,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitStatusDetails>> {
	const detected = await detectGitRepos(session.cwd);
	if (!detected || detected.repos.length === 0) {
		throw new ToolError("No Git repository detected for this session.");
	}

	const rootExcludes = detected.repos
		.slice(1)
		.map(repoPath => path.relative(detected.root, repoPath).replaceAll("\\", "/"))
		.filter(relativePath => relativePath.length > 0);
	const rootPathspecs =
		rootExcludes.length > 0 ? [":/", ...rootExcludes.map(relativePath => `:(exclude)${relativePath}`)] : undefined;
	const repos = await Promise.all(
		detected.repos.map(async repoPath => {
			const rawStatus = await git.status(repoPath, {
				porcelainV1: true,
				untrackedFiles: "all",
				signal,
				...(repoPath === detected.root && rootPathspecs ? { pathspecs: rootPathspecs } : {}),
			});
			return formatStatusRepo(session, repoPath, rawStatus);
		}),
	);

	const details: GitStatusDetails = { op: "status", root: detected.root, repos };
	return toolResult<GitStatusDetails>(details).text(formatGitStatusText(repos)).done();
}

function formatStatusRepo(session: ToolSession, repoPath: string, rawStatus: string): GitStatusRepoEntry {
	const entries = parsePorcelainStatus(rawStatus);
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.staged) staged++;
		if (entry.unstaged) unstaged++;
		if (entry.untracked) untracked++;
		if (files.length < STATUS_FILE_LIMIT) files.push(entry.path);
	}
	return {
		repoPath,
		label: formatRepoLabel(session.cwd, repoPath),
		clean: entries.length === 0,
		staged,
		unstaged,
		untracked,
		files,
	};
}

function parsePorcelainStatus(rawStatus: string): PorcelainEntry[] {
	const entries: PorcelainEntry[] = [];
	for (const line of rawStatus.split("\n")) {
		if (line.length < 3) continue;
		const x = line[0];
		const y = line[1];
		if (x === "!" && y === "!") continue;
		const rawPath = line.slice(3).trim();
		if (!rawPath) continue;
		const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").pop() ?? rawPath) : rawPath;
		const untracked = x === "?" && y === "?";
		entries.push({
			path,
			untracked,
			staged: !untracked && x !== " ",
			unstaged: !untracked && y !== " ",
		});
	}
	return entries;
}

function formatGitStatusText(repos: readonly GitStatusRepoEntry[]): string {
	if (repos.length === 0) return "No Git repositories detected.";
	const lines: string[] = [];
	for (const repo of repos) {
		if (repo.clean) {
			lines.push(`${repo.label}: clean`);
			continue;
		}
		lines.push(
			`${repo.label}: dirty — staged ${repo.staged}, unstaged ${repo.unstaged}, untracked ${repo.untracked}`,
		);
		for (const file of repo.files) lines.push(`  - ${file}`);
	}
	return lines.join("\n");
}

export function formatGitCheckpointResultText(
	session: ToolSession,
	entries: readonly GitCheckpointRepoEntry[],
): string {
	if (entries.length === 0) {
		return "No dirty repos.";
	}
	const lines: string[] = [];
	for (const entry of entries) {
		const repoLabel = formatRepoLabel(session.cwd, entry.repoPath);
		if (entry.status === "committed") {
			const sha = entry.sha ?? "unknown";
			const fileWord = entry.filesChanged === 1 ? "file" : "files";
			const subject = entry.message?.trim().split("\n")[0];
			const suffix = subject ? ` — ${subject}` : "";
			lines.push(`${repoLabel}: ${sha} (${entry.filesChanged} ${fileWord})${suffix}`);
		} else if (entry.status === "skipped") {
			lines.push(`${repoLabel}: skipped (${entry.reason ?? "no-changes"})`);
		} else {
			lines.push(`${repoLabel}: failed — ${entry.error ?? "unknown error"}`);
		}
	}
	return lines.join("\n");
}
