import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { readFileSnapshot, writeBlob } from "./blobs";
import { discoverNestedGitRepos } from "./repos";
import { nativePatchExists, writeManifestAtomic } from "./store";
import type {
	CreateNativePatchInput,
	CreateNativePatchResult,
	NativePatchFileEntry,
	NativePatchManifest,
	PatchStore,
} from "./types";
import { comparePaths, hasGitSegment, isPathInsideOrEqual, normalizeRelativePath, nowIso, toPosixPath } from "./utils";

interface CandidateSet {
	paths: Set<string>;
	nestedRoots: string[];
}

function relativeStoreRoots(root: string, store: PatchStore): string[] {
	const resolvedRoot = path.resolve(root);
	const roots: string[] = [];
	for (const candidate of [store.root, store.blobsDir, store.manifestsDir]) {
		const resolvedCandidate = path.resolve(candidate);
		if (!isPathInsideOrEqual(resolvedRoot, resolvedCandidate)) continue;
		const relative = toPosixPath(path.relative(resolvedRoot, resolvedCandidate));
		if (relative) roots.push(relative);
	}
	roots.sort(comparePaths);
	return roots.filter(
		(entry, index) => !roots.some((other, otherIndex) => otherIndex < index && isUnderRelativeRoot(entry, other)),
	);
}

function isUnderRelativeRoot(relativePath: string, relativeRoot: string): boolean {
	return relativePath === relativeRoot || relativePath.startsWith(`${relativeRoot}/`);
}

function isUnderAnyNestedRepo(relativePath: string, nestedRoots: readonly string[]): boolean {
	for (const nestedRoot of nestedRoots) {
		if (relativePath === nestedRoot || relativePath.startsWith(`${nestedRoot}/`)) return true;
	}
	return false;
}

async function listCandidates(root: string, store: PatchStore): Promise<CandidateSet> {
	const resolvedRoot = path.resolve(root);
	const [globResult, nestedAbsoluteRoots] = await Promise.all([
		glob({
			path: resolvedRoot,
			pattern: "**/*",
			hidden: true,
			gitignore: true,
			includeNodeModules: true,
		}),
		discoverNestedGitRepos(resolvedRoot),
	]);
	const nestedRoots = nestedAbsoluteRoots
		.map(repo => normalizeRelativePath(path.relative(resolvedRoot, repo)))
		.sort(comparePaths);
	const storeRelativeRoots = relativeStoreRoots(resolvedRoot, store);
	const paths = new Set<string>();
	for (const match of globResult.matches) {
		if (match.fileType !== FileType.File && match.fileType !== FileType.Symlink) continue;
		const relativePath = normalizeRelativePath(match.path);
		if (hasGitSegment(relativePath)) continue;
		if (storeRelativeRoots.some(root => isUnderRelativeRoot(relativePath, root))) continue;
		if (isUnderAnyNestedRepo(relativePath, nestedRoots)) continue;
		paths.add(relativePath);
	}
	return { paths, nestedRoots };
}

async function makePatchId(store: PatchStore, requestedId: string | undefined): Promise<string> {
	if (requestedId) {
		if (await nativePatchExists(store, requestedId)) {
			throw new Error(`native patch already exists: ${requestedId}`);
		}
		return requestedId;
	}
	while (true) {
		const id = Snowflake.next();
		if (!(await nativePatchExists(store, id))) return id;
	}
}

async function resolveRepoRoot(input: CreateNativePatchInput): Promise<string | undefined> {
	if (input.repoRoot) return path.resolve(input.repoRoot);
	try {
		return (await git.repo.root(input.targetRoot)) ?? undefined;
	} catch {
		return undefined;
	}
}

export async function createNativePatch(input: CreateNativePatchInput): Promise<CreateNativePatchResult> {
	const baselineRoot = path.resolve(input.baselineRoot);
	const changedRoot = path.resolve(input.changedRoot);
	const targetRoot = path.resolve(input.targetRoot);
	await Promise.all([fs.access(baselineRoot), fs.access(changedRoot)]);

	const [baselineCandidates, changedCandidates] = await Promise.all([
		listCandidates(baselineRoot, input.store),
		listCandidates(changedRoot, input.store),
	]);
	const allPaths = new Set<string>([...baselineCandidates.paths, ...changedCandidates.paths]);
	const files: NativePatchFileEntry[] = [];
	let blobCount = 0;

	for (const relativePath of [...allPaths].sort(comparePaths)) {
		const baseline = await readFileSnapshot(path.join(baselineRoot, relativePath));
		const changed = await readFileSnapshot(path.join(changedRoot, relativePath));
		if (baseline?.hash === changed?.hash && baseline?.mode === changed?.mode) continue;
		if (baseline) {
			await writeBlob(input.store, baseline.content);
			blobCount += 1;
		}
		if (changed) {
			await writeBlob(input.store, changed.content);
			blobCount += 1;
		}
		if (!baseline && changed) {
			files.push({
				afterHash: changed.hash,
				mode: changed.mode,
				op: "add",
				path: relativePath,
				size: changed.size,
			});
			continue;
		}
		if (baseline && !changed) {
			files.push({
				beforeHash: baseline.hash,
				mode: baseline.mode,
				op: "delete",
				path: relativePath,
				size: 0,
			});
			continue;
		}
		if (baseline && changed) {
			files.push({
				afterHash: changed.hash,
				beforeHash: baseline.hash,
				mode: changed.mode,
				op: "modify",
				path: relativePath,
				size: changed.size,
			});
		}
	}

	const now = nowIso();
	const manifest: NativePatchManifest = {
		version: 1,
		id: await makePatchId(input.store, input.id),
		taskId: input.taskId,
		description: input.description,
		targetRoot,
		repoRoot: await resolveRepoRoot(input),
		createdAt: now,
		updatedAt: now,
		status: "pending",
		files,
		message: input.message,
	};
	await writeManifestAtomic(input.store, manifest);
	return { manifest, store: input.store, empty: files.length === 0, blobCount };
}
