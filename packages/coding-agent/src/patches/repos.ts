import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { comparePaths, toPosixPath } from "./utils";

async function hasGitEntry(dir: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(path.join(dir, ".git"));
		return stats.isDirectory() || stats.isFile();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * Resolve the git root that `cwd` belongs to: the nearest enclosing directory
 * with a `.git` entry, ascending from `cwd`. Stops at the first hit — it never
 * climbs past the owning repo into an enclosing parent repo, so a checkout
 * nested inside another repo (e.g. a worktree or sub-clone under a superproject)
 * scopes to itself, not the parent and its sibling repos. Returns null when no
 * enclosing repo exists.
 */
async function nearestGitRoot(cwd: string): Promise<string | null> {
	let current = path.resolve(cwd);
	for (;;) {
		if (await hasGitEntry(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function submodulePathSet(repoRoot: string): Promise<Set<string>> {
	try {
		return new Set((await git.ls.submodules(repoRoot)).map(toPosixPath));
	} catch {
		return new Set();
	}
}

/**
 * Directories pruned during nested-repo discovery. Dot-prefixed names (`.git`,
 * `.ditto` task overlays, other caches) and `node_modules` are skipped so checkpoint
 * discovery never recurses into task overlay/worktree internals and treats them as
 * nested repos to commit. Real staging stays `git add -A`, which still honors the
 * repo's own `.gitignore`/`.ignore` (including unignore) rules.
 */
function shouldPruneRepoDiscoveryDir(name: string): boolean {
	return name.startsWith(".") || name === "node_modules";
}

export async function discoverNestedGitRepos(root: string): Promise<string[]> {
	const resolvedRoot = path.resolve(root);
	const submodules = await submodulePathSet(resolvedRoot);
	const repos: string[] = [];

	async function walk(dir: string, relativeDir: string): Promise<void> {
		let entries: nodeFs.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (shouldPruneRepoDiscoveryDir(entry.name)) continue;
			const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			const child = path.join(dir, entry.name);
			if (await hasGitEntry(child)) {
				const normalizedRelative = toPosixPath(childRelative);
				if (!submodules.has(normalizedRelative)) {
					repos.push(child);
					continue;
				}
			}
			await walk(child, childRelative);
		}
	}

	await walk(resolvedRoot, "");
	repos.sort(comparePaths);
	return repos;
}

export async function detectGitRepos(cwd: string): Promise<{ root: string; repos: string[] } | null> {
	const root = await nearestGitRoot(cwd);
	if (!root) return null;
	const nested = await discoverNestedGitRepos(root);
	return { root, repos: [root, ...nested] };
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function formatRepoLabel(cwd: string, repoPath: string): string {
	const resolvedCwd = path.resolve(cwd);
	const resolvedRepo = path.resolve(repoPath);
	const relativeToCwd = path.relative(resolvedCwd, resolvedRepo);
	if (relativeToCwd === "") return ".";
	if (!relativeToCwd.startsWith("..") && !path.isAbsolute(relativeToCwd)) {
		return toPosixPath(relativeToCwd);
	}
	if (isWithin(resolvedRepo, resolvedCwd)) return path.basename(resolvedRepo) || resolvedRepo;

	const home = os.homedir();
	if (isWithin(home, resolvedRepo)) {
		const relativeToHome = path.relative(home, resolvedRepo);
		return relativeToHome ? `~/${toPosixPath(relativeToHome)}` : "~";
	}
	return toPosixPath(resolvedRepo);
}
