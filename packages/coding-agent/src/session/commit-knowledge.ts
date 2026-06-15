import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { detectGitRepos } from "../patches/repos";
import { toPosixPath } from "../patches/utils";
import * as git from "../utils/git";

const COMMIT_SUBJECT = "chore(knowledge): update .omp/knowledge";

export interface CommitKnowledgeOptions {
	/** Optional label recorded as a `Source:` body line on the commit. */
	sourceTitle?: string;
	signal?: AbortSignal;
}

export interface CommitKnowledgeResult {
	committed: boolean;
	/** Abbreviated SHA of the created commit, when one was made. */
	sha?: string;
	/** Why nothing was committed (`"no-git"`, `"clean"`, or a git error message). */
	reason?: string;
}

/**
 * Stage and commit ONLY the `<cwd>/.omp/knowledge` subtree of the enclosing git
 * repository, leaving every other staged or unstaged change untouched.
 *
 * Designed for the fire-and-forget knowledge pass: it NEVER throws. Failures —
 * no repository, a clean subtree, or any git error — surface as
 * `{ committed: false, reason }`.
 */
export async function commitKnowledgeFiles(
	cwd: string,
	opts: CommitKnowledgeOptions = {},
): Promise<CommitKnowledgeResult> {
	const { sourceTitle, signal } = opts;
	try {
		const detected = await detectGitRepos(cwd);
		if (!detected) {
			logger.debug("commitKnowledgeFiles: no enclosing git repo", { cwd });
			return { committed: false, reason: "no-git" };
		}

		const root = detected.root;
		// Pathspec scoped to the knowledge subtree, relative to the repo root and
		// forward-slashed so git accepts it on every platform.
		const rel = toPosixPath(path.relative(root, path.join(cwd, ".omp", "knowledge")));

		return await git.withRepoLock(
			root,
			async (): Promise<CommitKnowledgeResult> => {
				// Stage ONLY the knowledge subtree — never `git add -A`.
				await git.stage.files(root, [rel], signal);
				if (!(await git.diff.has(root, { cached: true, files: [rel], signal }))) {
					logger.debug("commitKnowledgeFiles: knowledge subtree is clean", { root, rel });
					return { committed: false, reason: "clean" };
				}

				const message = sourceTitle ? `${COMMIT_SUBJECT}\n\nSource: ${sourceTitle}` : COMMIT_SUBJECT;
				// Pathspec on `commit` commits only these paths, leaving any other
				// staged/unstaged changes out of the commit and untouched.
				await git.commit(root, message, { files: [rel], signal });
				const sha = (await git.head.short(root, undefined, signal)) ?? undefined;
				logger.debug("commitKnowledgeFiles: committed knowledge subtree", { root, rel, sha });
				return { committed: true, sha };
			},
			signal,
		);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.debug("commitKnowledgeFiles: commit failed", { cwd, reason });
		return { committed: false, reason };
	}
}
