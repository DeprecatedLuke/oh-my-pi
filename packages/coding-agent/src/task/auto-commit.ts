import * as path from "node:path";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { detectGitRepos, discoverNestedGitRepos } from "../patches";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";

export interface DirtyRepoReport {
	root: string;
	repos: string[];
}

/**
 * Build git pathspecs that exclude nested repositories from a parent repo's
 * staging/status so a dirty child is never staged or counted as part of its parent.
 * Returns an empty array when there are no nested repos (caller then stages everything).
 */
function excludeNestedPathspecs(repoRoot: string, nestedRepoPaths: readonly string[]): string[] {
	const excludes = nestedRepoPaths
		.map(nestedPath => path.relative(repoRoot, nestedPath).replaceAll("\\", "/"))
		.filter(relativePath => relativePath.length > 0);
	return excludes.length > 0 ? [":/", ...excludes.map(relativePath => `:(exclude)${relativePath}`)] : [];
}

/**
 * Enumerate every dirty git repository under the outermost repo root containing `cwd`.
 * Used by the `git` checkpoint flow to decide which repos need committing. Repo discovery
 * (root + unlinked nested repos) reuses {@link detectGitRepos}, the same detection the
 * `git status` path uses, and nested repos are excluded from the root's status so a dirty
 * child does not also mark the parent dirty.
 */
export async function dirtyRepos(cwd: string): Promise<DirtyRepoReport> {
	const detected = await detectGitRepos(cwd);
	if (!detected) return { root: path.resolve(cwd), repos: [] };
	const { root, repos: allRepos } = detected;
	const rootPathspecs = excludeNestedPathspecs(root, allRepos.slice(1));
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
	return {
		root,
		repos: statuses.filter(entry => entry.status.trim().length > 0).map(entry => entry.repoPath),
	};
}

export interface CommitDirtyRepoEntry {
	repoPath: string;
	status: "committed" | "skipped" | "failed";
	sha?: string;
	filesChanged: number;
	message?: string;
	reason?: "no-changes";
	error?: string;
}

export interface CommitDirtyReposOptions {
	cwd: string;
	modelRegistry: ModelRegistry | undefined;
	settings: Settings;
	sessionId?: string;
}

/**
 * Commit every dirty repo under `cwd` using a model-generated commit message per repo.
 *
 * Used by the `git` tool as the LLM-invoked scope closer.
 * Discovery runs before `git add -A`, so nested repos are never staged as a side effect
 * of checkpointing. Entries with no staged content after `git add` are returned as `skipped`.
 * Throws only when the caller passes no `modelRegistry` AND a commit would be required —
 * otherwise each repo's failure is reported in its entry so a partial failure does not
 * block siblings.
 */
export async function commitDirtyRepos(options: CommitDirtyReposOptions): Promise<CommitDirtyRepoEntry[]> {
	const { cwd, modelRegistry, settings, sessionId } = options;
	const { repos } = await dirtyRepos(cwd);
	if (repos.length === 0) return [];
	if (!modelRegistry) {
		throw new Error("A model registry is required to generate a commit message.");
	}

	const entries: CommitDirtyRepoEntry[] = [];
	for (const repoPath of repos) {
		try {
			entries.push(await commitSingleRepo(repoPath, modelRegistry, settings, sessionId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			entries.push({
				repoPath,
				status: "failed",
				filesChanged: 0,
				error: message,
			});
		}
	}
	return entries;
}

async function commitSingleRepo(
	repoPath: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
	sessionId: string | undefined,
): Promise<CommitDirtyRepoEntry> {
	const nestedRepos = await discoverNestedGitRepos(repoPath);
	const stagePathspecs = excludeNestedPathspecs(repoPath, nestedRepos);
	await git.stage.files(repoPath, stagePathspecs);
	const stagedFiles = await git.diff.changedFiles(repoPath, { cached: true });
	if (stagedFiles.length === 0) {
		return {
			repoPath,
			status: "skipped",
			filesChanged: 0,
			reason: "no-changes",
		};
	}
	const diff = await git.diff(repoPath, { cached: true });
	const message = await generateCommitMessage(diff, modelRegistry, settings, sessionId);
	if (!message) {
		throw new Error("Could not generate a commit message.");
	}
	await git.commit(repoPath, message);
	const sha = (await git.head.short(repoPath)) ?? undefined;
	return {
		repoPath,
		status: "committed",
		sha,
		filesChanged: stagedFiles.length,
		message,
	};
}
