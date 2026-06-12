import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanConflictLines } from "../tools/conflict-detect";
import * as git from "../utils/git";
import { filePermissionMode, isSymlinkMode, readBlob, readBlobText, readFileSnapshot, writeBlob } from "./blobs";
import { canMergeAsText, merge2WayAddConflict, merge3Way } from "./merge";
import { discoverNestedGitRepos, formatRepoLabel } from "./repos";
import { listNativePatches, readNativePatch, writeManifestAtomic } from "./store";
import type {
	ApplyNativePatchOptions,
	ApplyNativePatchResult,
	NativePatchConflict,
	NativePatchFileEntry,
	NativePatchManifest,
	PatchStore,
	PatchValidationResult,
} from "./types";
import { cloneManifest, isHash, isPathInsideOrEqual, normalizeRelativePath, nowIso, toPosixPath } from "./utils";

interface TargetContext {
	targetRoot: string;
	repoRoot?: string;
	repoLabel?: string;
}

interface InternalValidationOptions extends ApplyNativePatchOptions {
	checkDirty?: boolean;
}

function dirtyMessage(repoLabel: string, patchId: string, repoPath: string): string {
	return `failed to apply ${repoLabel}/${patchId}: target repo is dirty, git commit ${repoPath} and reapply`;
}

function messageUnavailable(): Error {
	return new Error("commit message unavailable, populate message: and retry");
}

async function resolveRepoRoot(
	targetRoot: string,
	manifest: NativePatchManifest,
	options: ApplyNativePatchOptions,
): Promise<string | undefined> {
	if (options.repoRoot) return path.resolve(options.repoRoot);
	const detected = await git.repo.root(targetRoot, options.signal);
	if (detected) return detected;
	if (manifest.repoRoot && isPathInsideOrEqual(manifest.repoRoot, targetRoot)) {
		const manifestRepo = await git.repo.root(manifest.repoRoot, options.signal);
		if (manifestRepo) return manifestRepo;
	}
	return undefined;
}

async function resolveTargetContext(
	manifest: NativePatchManifest,
	options: ApplyNativePatchOptions,
): Promise<TargetContext> {
	const targetRoot = path.resolve(options.targetRoot ?? manifest.targetRoot);
	const repoRoot = await resolveRepoRoot(targetRoot, manifest, options);
	const repoLabel = repoRoot ? (options.repoLabel ?? formatRepoLabel(options.cwd ?? targetRoot, repoRoot)) : undefined;
	return { targetRoot, repoRoot, repoLabel };
}

async function isRepoDirty(repoRoot: string, signal: AbortSignal | undefined): Promise<boolean> {
	const nestedRepos = await discoverNestedGitRepos(repoRoot);
	const pathspecs =
		nestedRepos.length > 0
			? [":/", ...nestedRepos.map(repo => `:(exclude)${toPosixPath(path.relative(repoRoot, repo))}`)]
			: undefined;
	const status = await git.status(repoRoot, {
		porcelainV1: true,
		untrackedFiles: "all",
		...(pathspecs ? { pathspecs } : {}),
		signal,
	});
	const summary = git.status.parse(status);
	return summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0;
}

function missingAfterConflict(entry: NativePatchFileEntry): NativePatchConflict | null {
	if (entry.op !== "delete" && !isHash(entry.afterHash)) {
		return { path: entry.path, reason: "patch entry is missing final content" };
	}
	if (entry.op !== "add" && !isHash(entry.beforeHash)) {
		return { path: entry.path, reason: "patch entry is missing baseline content hash" };
	}
	return null;
}

async function validateEntry(targetRoot: string, entry: NativePatchFileEntry): Promise<NativePatchConflict | null> {
	const structuralConflict = missingAfterConflict(entry);
	if (structuralConflict) return structuralConflict;
	const relativePath = normalizeRelativePath(entry.path);
	const current = await readFileSnapshot(path.join(targetRoot, relativePath));
	if (entry.op === "add") {
		if (current) return { actualHash: current.hash, path: entry.path, reason: "target file already exists" };
		return null;
	}
	if (!current) {
		return { expectedHash: entry.beforeHash, path: entry.path, reason: "target file is missing" };
	}
	if (current.hash !== entry.beforeHash) {
		return {
			actualHash: current.hash,
			expectedHash: entry.beforeHash,
			path: entry.path,
			reason: "target file content differs from patch baseline",
		};
	}
	return null;
}

function validationMessage(
	manifest: NativePatchManifest,
	conflicts: readonly NativePatchConflict[],
	dirty?: string,
): string {
	if (dirty) return dirty;
	if (conflicts.length === 0) return `patch ${manifest.id} validates cleanly`;
	const details = conflicts
		.slice(0, 5)
		.map(conflict => `${conflict.path}: ${conflict.reason}`)
		.join("; ");
	const suffix = conflicts.length > 5 ? `; ${conflicts.length - 5} more` : "";
	return `patch ${manifest.id} has ${conflicts.length} conflict${
		conflicts.length === 1 ? "" : "s"
	}: ${details}${suffix}`;
}

export async function validateManifestAgainstTarget(
	manifest: NativePatchManifest,
	options: InternalValidationOptions = {},
): Promise<PatchValidationResult> {
	const context = await resolveTargetContext(manifest, options);
	if (manifest.status === "dropped") {
		const conflict = { path: "", reason: "patch is dropped" };
		return {
			ok: false,
			valid: false,
			manifest: cloneManifest(manifest),
			conflicts: [conflict],
			message: validationMessage(manifest, [conflict]),
		};
	}
	if (manifest.status === "applied") {
		const conflict = { path: "", reason: "patch is already applied" };
		return {
			ok: false,
			valid: false,
			manifest: cloneManifest(manifest),
			conflicts: [conflict],
			message: validationMessage(manifest, [conflict]),
		};
	}
	if (options.checkDirty && context.repoRoot && (await isRepoDirty(context.repoRoot, options.signal))) {
		const message = dirtyMessage(
			context.repoLabel ?? formatRepoLabel(options.cwd ?? context.targetRoot, context.repoRoot),
			manifest.id,
			context.repoRoot,
		);
		return { ok: false, valid: false, manifest: cloneManifest(manifest), conflicts: [], dirty: true, message };
	}
	const conflicts: NativePatchConflict[] = [];
	for (const entry of manifest.files) {
		const conflict = await validateEntry(context.targetRoot, entry);
		if (conflict) conflicts.push(conflict);
	}
	const ok = conflicts.length === 0;
	return {
		ok,
		valid: ok,
		manifest: cloneManifest(manifest),
		conflicts,
		message: validationMessage(manifest, conflicts),
	};
}

export async function validateNativePatch(
	store: PatchStore,
	id: string,
	options: ApplyNativePatchOptions = {},
): Promise<PatchValidationResult> {
	return validateManifestAgainstTarget(await readNativePatch(store, id), { ...options, checkDirty: true });
}

async function writeFinalFile(store: PatchStore, targetRoot: string, entry: NativePatchFileEntry): Promise<void> {
	const relativePath = normalizeRelativePath(entry.path);
	const targetPath = path.join(targetRoot, relativePath);
	if (entry.op === "delete") {
		await fs.rm(targetPath, { force: true });
		return;
	}
	if (!entry.afterHash) throw new Error(`patch entry ${entry.path} has no final blob`);
	const content = await readBlob(store, entry.afterHash);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.rm(targetPath, { force: true });
	if (isSymlinkMode(entry.mode)) {
		await fs.symlink(new TextDecoder().decode(content), targetPath);
		return;
	}
	await Bun.write(targetPath, content);
	await fs.chmod(targetPath, filePermissionMode(entry)).catch(() => {});
}

function gitStagePath(repoRoot: string, targetRoot: string, entry: NativePatchFileEntry): string {
	const absolutePath = path.join(targetRoot, normalizeRelativePath(entry.path));
	if (!isPathInsideOrEqual(repoRoot, absolutePath)) {
		throw new Error(`patch file ${entry.path} is outside git repository ${repoRoot}`);
	}
	return toPosixPath(path.relative(repoRoot, absolutePath));
}

async function resolveCommitMessage(manifest: NativePatchManifest, options: ApplyNativePatchOptions): Promise<string> {
	const existing = manifest.message?.trim();
	if (existing) return existing;
	let generated: string | null | undefined;
	try {
		generated = await options.generateMessage?.(cloneManifest(manifest));
	} catch {
		throw messageUnavailable();
	}
	const message = generated?.trim();
	if (!message) throw messageUnavailable();
	manifest.message = message;
	return message;
}

async function applyValidatedFiles(
	store: PatchStore,
	targetRoot: string,
	files: readonly NativePatchFileEntry[],
): Promise<void> {
	for (const entry of files) await writeFinalFile(store, targetRoot, entry);
}

async function markApplied(store: PatchStore, manifest: NativePatchManifest): Promise<NativePatchManifest> {
	const now = nowIso();
	manifest.status = "applied";
	manifest.appliedAt = now;
	manifest.updatedAt = now;
	delete manifest.conflicts;
	return writeManifestAtomic(store, manifest);
}

async function markConflicted(
	store: PatchStore,
	manifest: NativePatchManifest,
	conflicts: NativePatchConflict[],
): Promise<NativePatchManifest> {
	manifest.status = "conflicted";
	manifest.conflicts = conflicts;
	manifest.updatedAt = nowIso();
	return writeManifestAtomic(store, manifest);
}

function isMarkerResolutionPending(manifest: NativePatchManifest): boolean {
	if (manifest.status !== "conflicted") return false;
	return (manifest.conflicts ?? []).some(conflict => conflict.markersWritten);
}

function markerResolutionLockPending(manifest: NativePatchManifest): boolean {
	return manifest.status === "conflicted" && isMarkerResolutionPending(manifest);
}

function samePatchLockScope(manifest: NativePatchManifest, context: TargetContext): boolean {
	const manifestRepoRoot = manifest.repoRoot ? path.resolve(manifest.repoRoot) : undefined;
	if (manifestRepoRoot && context.repoRoot) return manifestRepoRoot === path.resolve(context.repoRoot);

	const manifestTargetRoot = path.resolve(manifest.targetRoot);
	const targetRoot = path.resolve(context.targetRoot);
	if (manifestTargetRoot === targetRoot) return true;
	if (isPathInsideOrEqual(manifestTargetRoot, targetRoot) || isPathInsideOrEqual(targetRoot, manifestTargetRoot)) {
		return true;
	}

	if (!context.repoRoot) return false;
	const repoRoot = path.resolve(context.repoRoot);
	return isPathInsideOrEqual(manifestTargetRoot, repoRoot) || isPathInsideOrEqual(repoRoot, manifestTargetRoot);
}

function patchLockMessage(blocking: NativePatchManifest, blocked: NativePatchManifest, context: TargetContext): string {
	const label = context.repoLabel ?? formatRepoLabel(context.targetRoot, context.repoRoot ?? context.targetRoot);
	return [
		`failed to apply ${label}/${blocked.id}: target is locked by unresolved patch ${blocking.id}`,
		"resolve its conflict markers, then run patch apply/reapply on the locked patch to commit and unlock before applying other patches",
	].join("\n");
}

async function findBlockingMarkerPatch(
	store: PatchStore,
	manifest: NativePatchManifest,
	context: TargetContext,
): Promise<NativePatchManifest | undefined> {
	const patches = await listNativePatches(store, { listDropped: false });
	return patches.find(
		patch => patch.id !== manifest.id && markerResolutionLockPending(patch) && samePatchLockScope(patch, context),
	);
}

async function assertPatchTargetUnlocked(
	store: PatchStore,
	manifest: NativePatchManifest,
	context: TargetContext,
): Promise<void> {
	const blocking = await findBlockingMarkerPatch(store, manifest, context);
	if (blocking) throw new Error(patchLockMessage(blocking, manifest, context));
}

/**
 * Diff3-merge each content-conflict into the target file with `<<<<<<<` /
 * `|||||||` / `=======` / `>>>>>>>` markers labeled `patched` / `baseline` /
 * `current`. The agent then reads each target file through the standard
 * `read` tool, which scans the markers via `conflict-detect.ts` and
 * registers `conflict://<N>` IDs the agent resolves with `write
 * conflict://<N>`. Reapplying the patch snapshots the resolved disk
 * content as the entry's final state and stages it normally.
 *
 * Returns the per-conflict result list. Each entry mirrors the input
 * conflict's `path`/`reason`/`expectedHash`/`actualHash`; `markersWritten`
 * is set to `true` only on entries where the diff3 merge produced markers
 * on disk (i.e. the file truly conflicted). Cleanly-mergeable entries are
 * applied in place and dropped from the returned list. Unmergeable
 * conflicts (binary, symlink, structural, delete-side, target missing)
 * fall through unchanged so callers can still record them as plain
 * conflicts.
 */
async function materializeConflictMarkers(
	store: PatchStore,
	manifest: NativePatchManifest,
	conflicts: readonly NativePatchConflict[],
	context: TargetContext,
): Promise<{ resolvedFiles: string[]; conflicts: NativePatchConflict[] }> {
	const entryByPath = new Map(manifest.files.map(entry => [entry.path, entry]));
	const out: NativePatchConflict[] = [];
	const resolvedFiles: string[] = [];
	for (const conflict of conflicts) {
		const entry = entryByPath.get(conflict.path);
		const materialized = entry
			? await tryMaterializeOne(store, context.targetRoot, entry, manifest.id)
			: { kind: "passthrough" as const };
		if (materialized.kind === "markers") {
			out.push({ ...conflict, markersWritten: true });
		} else if (materialized.kind === "applied") {
			resolvedFiles.push(conflict.path);
		} else {
			out.push(conflict);
		}
	}
	return { resolvedFiles, conflicts: out };
}

type MaterializeOne = { kind: "markers" } | { kind: "applied" } | { kind: "passthrough" };

async function tryMaterializeOne(
	store: PatchStore,
	targetRoot: string,
	entry: NativePatchFileEntry,
	patchId: string,
): Promise<MaterializeOne> {
	// Only modify/add ops can carry text markers; delete-vs-divergent and
	// missing-hash conflicts have no meaningful "what does the agent pick?"
	// representation as a single marker block. Leave them as plain conflicts.
	if (entry.op === "delete") return { kind: "passthrough" };
	if (!isHash(entry.afterHash)) return { kind: "passthrough" };
	const absPath = path.join(targetRoot, normalizeRelativePath(entry.path));
	const current = await readFileSnapshot(absPath);
	// add-op + missing target = no conflict to merge; modify-op + missing
	// target = "the target was deleted out from under us" — represent it
	// as a plain conflict, the agent should decide intentionally.
	if (!current) return { kind: "passthrough" };
	if (current.isSymlink || isSymlinkMode(entry.mode)) return { kind: "passthrough" };
	const patchedBytes = await readBlob(store, entry.afterHash);
	if (!canMergeAsText(patchedBytes) || !canMergeAsText(current.content)) return { kind: "passthrough" };
	const baselineText =
		entry.op === "add" ? "" : isHash(entry.beforeHash) ? await readBlobText(store, entry.beforeHash) : undefined;
	if (entry.op === "modify" && baselineText === undefined) return { kind: "passthrough" };
	const patchedText = new TextDecoder("utf-8", { fatal: false }).decode(patchedBytes);
	const currentText = new TextDecoder("utf-8", { fatal: false }).decode(current.content);
	const labelPatched = `patched (patch://${patchId})`;
	const labelCurrent = "current (worktree)";
	const merged =
		entry.op === "add"
			? await merge2WayAddConflict({
					patched: patchedText,
					current: currentText,
					patchedLabel: labelPatched,
					currentLabel: labelCurrent,
				})
			: await merge3Way({
					patched: patchedText,
					baseline: baselineText ?? "",
					current: currentText,
					patchedLabel: labelPatched,
					baselineLabel: "baseline (pre-patch)",
					currentLabel: labelCurrent,
				});
	await fs.mkdir(path.dirname(absPath), { recursive: true });
	await Bun.write(absPath, merged.merged);
	await fs.chmod(absPath, filePermissionMode(entry)).catch(() => {});
	return merged.conflictCount === 0 ? { kind: "applied" } : { kind: "markers" };
}

/**
 * Re-apply path for a patch in marker-resolution-pending state. For each
 * marker-written conflict, verify the target file no longer carries
 * `<<<<<<<` / `=======` / `>>>>>>>` markers (i.e. the agent resolved them
 * via `conflict://<N>`), snapshot the disk content as the new
 * `afterHash` / `beforeHash` / `size` / `mode` on the manifest entry, then
 * proceed with the normal stage-and-commit flow. Files that still carry
 * markers stay flagged so the caller can report the remaining work.
 *
 * Skips the standard repo-dirty check: by construction the worktree IS
 * dirty here (the marker-bearing target files plus the agent's resolution
 * edits). The materialized files are the patch's own paths and are about
 * to be staged in this same call.
 */
async function finalizeMarkerResolution(
	store: PatchStore,
	manifest: NativePatchManifest,
	context: TargetContext,
	options: ApplyNativePatchOptions,
): Promise<ApplyNativePatchResult> {
	const updated = cloneManifest(manifest);
	const conflicts = updated.conflicts ?? [];
	const remaining: NativePatchConflict[] = [];
	const finalizedPaths: string[] = [];
	for (const conflict of conflicts) {
		if (!conflict.markersWritten) {
			remaining.push(conflict);
			continue;
		}
		const entryIdx = updated.files.findIndex(file => file.path === conflict.path);
		const entry = entryIdx >= 0 ? updated.files[entryIdx] : undefined;
		if (!entry) {
			remaining.push({ ...conflict, reason: "no matching patch entry on retry" });
			continue;
		}
		const absPath = path.join(context.targetRoot, normalizeRelativePath(entry.path));
		const snapshot = await readFileSnapshot(absPath);
		if (!snapshot) {
			remaining.push({ ...conflict, reason: "target file disappeared after marker materialization" });
			continue;
		}
		const text = new TextDecoder("utf-8", { fatal: false }).decode(snapshot.content);
		const lines = text.split("\n");
		const blocks = scanConflictLines(lines, 1);
		if (blocks.length > 0) {
			const word = blocks.length === 1 ? "block" : "blocks";
			remaining.push({
				path: conflict.path,
				reason: `unresolved conflict markers remain (${blocks.length} ${word}) — resolve with conflict://<N>`,
				markersWritten: true,
			});
			continue;
		}
		// Persist disk content as the patch's final state. Setting beforeHash
		// to the same hash makes validateEntry treat the patch as in-place;
		// writeFinalFile during the apply phase will be a content-identical
		// no-op (it reads the blob we just wrote and writes it back).
		const afterHash = await writeBlob(store, snapshot.content);
		updated.files[entryIdx] = {
			...entry,
			beforeHash: afterHash,
			afterHash,
			mode: snapshot.mode,
			size: snapshot.size,
		};
		finalizedPaths.push(conflict.path);
	}
	if (remaining.length > 0) {
		updated.conflicts = remaining;
		updated.updatedAt = nowIso();
		const saved = await writeManifestAtomic(store, updated);
		return { applied: false, committed: false, files: saved.files, manifest: saved };
	}
	delete updated.conflicts;
	updated.status = "pending";
	updated.updatedAt = nowIso();
	await writeManifestAtomic(store, updated);

	if (!context.repoRoot) {
		await applyValidatedFiles(store, context.targetRoot, updated.files);
		const applied = await markApplied(store, updated);
		return { applied: true, committed: false, files: applied.files, manifest: applied };
	}
	let message: string | undefined;
	if (updated.files.length > 0) {
		try {
			message = await resolveCommitMessage(updated, options);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`failed to apply ${context.repoLabel ?? formatRepoLabel(options.cwd ?? context.targetRoot, context.repoRoot)}/${updated.id}: ${detail}`,
			);
		}
		await writeManifestAtomic(store, updated);
	}
	await applyValidatedFiles(store, context.targetRoot, updated.files);
	let committed = false;
	let commit: string | undefined;
	if (updated.files.length > 0) {
		const repoRoot = context.repoRoot;
		const stagePaths = updated.files.map(file => gitStagePath(repoRoot, context.targetRoot, file));
		await git.stage.files(repoRoot, stagePaths, options.signal);
		if (await git.diff.has(repoRoot, { cached: true, files: stagePaths, signal: options.signal })) {
			await git.commit(repoRoot, message!, { files: stagePaths, signal: options.signal });
			committed = true;
			commit = (await git.head.sha(repoRoot, options.signal)) ?? undefined;
		}
	}
	const applied = await markApplied(store, updated);
	void finalizedPaths;
	return { applied: true, commit, committed, files: applied.files, manifest: applied };
}

async function applyNativePatchInner(
	store: PatchStore,
	manifest: NativePatchManifest,
	options: ApplyNativePatchOptions,
): Promise<ApplyNativePatchResult> {
	const context = await resolveTargetContext(manifest, options);
	if (!isMarkerResolutionPending(manifest)) await assertPatchTargetUnlocked(store, manifest, context);
	if (isMarkerResolutionPending(manifest)) {
		return finalizeMarkerResolution(store, manifest, context, options);
	}
	const validation = await validateManifestAgainstTarget(manifest, { ...options, checkDirty: true });
	if (validation.dirty) throw new Error(validation.message);
	if (!validation.ok) {
		const materialized = await materializeConflictMarkers(store, manifest, validation.conflicts, context);
		const wroteMarkers = materialized.conflicts.some(conflict => conflict.markersWritten);
		if (wroteMarkers) {
			const updated = await markConflicted(store, manifest, materialized.conflicts);
			return { applied: false, committed: false, files: updated.files, manifest: updated };
		}
		const updated = await markConflicted(store, manifest, materialized.conflicts);
		return { applied: false, committed: false, files: updated.files, manifest: updated };
	}
	if (!context.repoRoot) {
		await applyValidatedFiles(store, context.targetRoot, manifest.files);
		const applied = await markApplied(store, manifest);
		return { applied: true, committed: false, files: applied.files, manifest: applied };
	}
	let message: string | undefined;
	if (manifest.files.length > 0) {
		try {
			message = await resolveCommitMessage(manifest, options);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`failed to apply ${context.repoLabel ?? formatRepoLabel(options.cwd ?? context.targetRoot, context.repoRoot)}/${manifest.id}: ${detail}`,
			);
		}
		await writeManifestAtomic(store, manifest);
	}
	await applyValidatedFiles(store, context.targetRoot, manifest.files);
	let committed = false;
	let commit: string | undefined;
	if (manifest.files.length > 0) {
		const repoRoot = context.repoRoot;
		const stagePaths = manifest.files.map(entry => gitStagePath(repoRoot, context.targetRoot, entry));
		await git.stage.files(repoRoot, stagePaths, options.signal);
		if (await git.diff.has(repoRoot, { cached: true, files: stagePaths, signal: options.signal })) {
			await git.commit(repoRoot, message!, { files: stagePaths, signal: options.signal });
			committed = true;
			commit = (await git.head.sha(repoRoot, options.signal)) ?? undefined;
		}
	}
	const applied = await markApplied(store, manifest);
	return { applied: true, commit, committed, files: applied.files, manifest: applied };
}

export async function applyNativePatch(
	store: PatchStore,
	id: string,
	options: ApplyNativePatchOptions = {},
): Promise<ApplyNativePatchResult> {
	const manifest = await readNativePatch(store, id);
	const context = await resolveTargetContext(manifest, options);
	if (context.repoRoot) {
		return git.withRepoLock(context.repoRoot, () => applyNativePatchInner(store, manifest, options), options.signal);
	}
	return applyNativePatchInner(store, manifest, options);
}
