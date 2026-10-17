import * as path from "node:path";
import { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { detectGitRepos, discoverNestedGitRepos, formatRepoLabel } from "../patches";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";

/** A repository with uncommitted changes, as reported by {@link dirtyRepos}. */
export interface DirtyRepo {
	repoPath: string;
	/** Display/selection label relative to the cwd checkpoint ran from (see `formatRepoLabel`). */
	label: string;
	changedFiles: number;
}

export interface CheckpointRepoEntry {
	repoPath: string;
	label: string;
	status: "committed" | "skipped" | "failed";
	sha?: string;
	filesChanged: number;
	message?: string;
	reason?: "no-changes";
	error?: string;
}

export interface CheckpointCommitOptions {
	cwd: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	sessionId?: string;
}

/** Model access for the commit stage, acquired only once a selection is about to commit. */
export interface CheckpointCommitDeps extends Omit<CheckpointCommitOptions, "cwd"> {
	/** Release resources acquired for the commit (e.g. a standalone auth storage). */
	release?: () => void;
}

/** Outcome of one {@link runCheckpointStage} call. */
export type CheckpointStageResult =
	| { stage: "clean" }
	| { stage: "listed"; dirty: DirtyRepo[] }
	| { stage: "unmatched"; unmatched: string[]; dirty: DirtyRepo[] }
	| { stage: "committed"; dirty: DirtyRepo[]; entries: CheckpointRepoEntry[] };

/**
 * Build git pathspecs that exclude nested repositories from a parent repo's
 * staging/status so a dirty child is never staged or counted as part of its parent.
 *
 * Only NON-gitignored nested repos are named. A gitignored nested repo is already
 * invisible to `git add`/`git status` (the ignore rules skip its tree), so it needs no
 * exclude — and naming a gitignored path in a `:(exclude)` pathspec makes `git add` die
 * ("The following paths are ignored by one of your .gitignore files"), which otherwise
 * fails the whole checkpoint in a monorepo that gitignores its unlinked nested repos.
 * Returns an empty array when nothing needs excluding (caller then stages everything via
 * `git add -A`, which honors .gitignore).
 */
async function excludeNestedPathspecs(repoRoot: string, nestedRepoPaths: readonly string[]): Promise<string[]> {
	const relatives = nestedRepoPaths
		.map(nestedPath => path.relative(repoRoot, nestedPath).replaceAll("\\", "/"))
		.filter(relativePath => relativePath.length > 0);
	if (relatives.length === 0) return [];
	const ignored = await git.checkIgnore(repoRoot, relatives);
	const excludes = relatives.filter(relativePath => !ignored.has(relativePath));
	return excludes.length > 0 ? [":/", ...excludes.map(relativePath => `:(exclude)${relativePath}`)] : [];
}

/**
 * Enumerate every dirty git repository under the git repo that contains `cwd`
 * (the nearest enclosing repo, not an outer parent repo it may be nested in), plus
 * the unlinked nested repos discovered beneath it. Nested repos are excluded from the
 * root's status so a dirty child does not also mark the parent dirty.
 */
export async function dirtyRepos(cwd: string): Promise<DirtyRepo[]> {
	const detected = await detectGitRepos(cwd);
	if (!detected) return [];
	const { root, repos: allRepos } = detected;
	const rootPathspecs = await excludeNestedPathspecs(root, allRepos.slice(1));
	const statuses = await Promise.all(
		allRepos.map(async repoPath => ({
			repoPath,
			status: await git.status(repoPath, {
				porcelainV1: true,
				untrackedFiles: "all",
				...(repoPath === root && rootPathspecs.length > 0 ? { pathspecs: rootPathspecs } : {}),
			}),
		})),
	);
	const dirty: DirtyRepo[] = [];
	for (const { repoPath, status } of statuses) {
		const changedFiles = status.split("\n").filter(line => line.trim().length > 0).length;
		if (changedFiles === 0) continue;
		dirty.push({ repoPath, label: formatRepoLabel(cwd, repoPath), changedFiles });
	}
	return dirty;
}

/**
 * Map user/agent-supplied repo names onto dirty repos. A name matches a repo by its
 * label (as printed by the listing stage) or by a path that resolves to the repo root
 * relative to `cwd`. Names that match no dirty repo are returned in `unmatched` so the
 * caller can refuse the whole request instead of committing a partial selection.
 */
export function selectDirtyRepos(
	cwd: string,
	dirty: readonly DirtyRepo[],
	names: readonly string[],
): { selected: DirtyRepo[]; unmatched: string[] } {
	const selected: DirtyRepo[] = [];
	const unmatched: string[] = [];
	for (const name of names) {
		const resolved = path.resolve(cwd, name);
		const match = dirty.find(repo => repo.label === name || path.resolve(repo.repoPath) === resolved);
		if (!match) {
			unmatched.push(name);
			continue;
		}
		if (!selected.includes(match)) selected.push(match);
	}
	return { selected, unmatched };
}

/**
 * Commit each given repo with a model-generated message. Nested repos are excluded from
 * a parent's staging so they are never embedded as gitlinks. A repo whose staging comes
 * up empty is `skipped`; per-repo failures are reported in the entry so one failure does
 * not block its siblings.
 */
export async function commitCheckpointRepos(
	repos: readonly DirtyRepo[],
	options: CheckpointCommitOptions,
): Promise<CheckpointRepoEntry[]> {
	const entries: CheckpointRepoEntry[] = [];
	for (const repo of repos) {
		try {
			entries.push(await commitSingleRepo(repo, options));
		} catch (error) {
			entries.push({
				repoPath: repo.repoPath,
				label: repo.label,
				status: "failed",
				filesChanged: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return entries;
}

/**
 * Two-stage checkpoint shared by `omp git checkpoint` and the `git_checkpoint` tool.
 * Without names, list the dirty repos and commit nothing, so the caller must name
 * exactly the repos it is responsible for. With names, every name must match a dirty
 * repo before anything is committed. `acquireCommitDeps` runs only for the commit stage;
 * its `release` runs once committing finishes.
 */
export async function runCheckpointStage(
	cwd: string,
	names: readonly string[],
	acquireCommitDeps: () => Promise<CheckpointCommitDeps>,
): Promise<CheckpointStageResult> {
	const dirty = await dirtyRepos(cwd);
	if (dirty.length === 0) return { stage: "clean" };
	if (names.length === 0) return { stage: "listed", dirty };
	const { selected, unmatched } = selectDirtyRepos(cwd, dirty, names);
	if (unmatched.length > 0) return { stage: "unmatched", unmatched, dirty };
	const { release, ...deps } = await acquireCommitDeps();
	try {
		return { stage: "committed", dirty, entries: await commitCheckpointRepos(selected, { cwd, ...deps }) };
	} finally {
		release?.();
	}
}

/**
 * Build a standalone model registry for checkpoint commits outside a live session
 * (the CLI, or a tool session without a registry). The returned `release` closes the
 * auth storage it opened.
 */
export async function createStandaloneCommitDeps(cwd: string, settings: Settings): Promise<CheckpointCommitDeps> {
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		await modelRegistry.refresh();
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return { modelRegistry, settings, release: () => authStorage.close() };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

async function commitSingleRepo(repo: DirtyRepo, options: CheckpointCommitOptions): Promise<CheckpointRepoEntry> {
	const { repoPath, label } = repo;
	const nestedRepos = await discoverNestedGitRepos(repoPath);
	const stagePathspecs = await excludeNestedPathspecs(repoPath, nestedRepos);
	await git.stage.files(repoPath, stagePathspecs);
	const stagedFiles = await git.diff.changedFiles(repoPath, { cached: true });
	if (stagedFiles.length === 0) {
		return { repoPath, label, status: "skipped", filesChanged: 0, reason: "no-changes" };
	}
	const diff = await git.diff(repoPath, { cached: true });
	const message = await generateCommitMessage(diff, options.modelRegistry, options.settings, options.sessionId);
	if (!message) {
		throw new Error("Could not generate a commit message.");
	}
	await git.commit(repoPath, message);
	const sha = (await git.head.short(repoPath)) ?? undefined;
	return { repoPath, label, status: "committed", sha, filesChanged: stagedFiles.length, message };
}

function pluralFiles(count: number): string {
	return `${count} ${count === 1 ? "file" : "files"}`;
}

/** Stage-one output: the dirty repos an agent may choose to checkpoint. */
export function formatDirtyRepoList(dirty: readonly DirtyRepo[]): string {
	return dirty.map(repo => `  ${repo.label} (${pluralFiles(repo.changedFiles)})`).join("\n");
}

export function formatCheckpointResult(entries: readonly CheckpointRepoEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.status === "committed") {
			const subject = entry.message?.trim().split("\n")[0];
			const suffix = subject ? ` — ${subject}` : "";
			lines.push(`${entry.label}: ${entry.sha ?? "unknown"} (${pluralFiles(entry.filesChanged)})${suffix}`);
		} else if (entry.status === "skipped") {
			lines.push(`${entry.label}: skipped (${entry.reason ?? "no-changes"})`);
		} else {
			lines.push(`${entry.label}: failed — ${entry.error ?? "unknown error"}`);
		}
	}
	return lines.join("\n");
}
