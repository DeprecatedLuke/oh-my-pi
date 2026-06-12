import * as path from "node:path";
import { validateManifestAgainstTarget } from "./apply";
import { encodeText, readBlobText, readFileSnapshot, writeBlob } from "./blobs";
import { readNativePatch, writeManifestAtomic } from "./store";
import type { NativePatchFileEntry, NativePatchManifest, PatchStore, WritePatchVirtualFileOptions } from "./types";
import { comparePaths, normalizeRelativePath, nowIso } from "./utils";

function formatBlock(name: string, value: string | undefined): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	if (lines.length === 1) return [`${name}: ${lines[0]}`];
	return [`${name}: |-`, ...lines.map(line => `  ${line}`)];
}

function formatManifestText(manifest: NativePatchManifest): string {
	const lines = [`id: ${manifest.id}`, `status: ${manifest.status}`, `targetRoot: ${manifest.targetRoot}`];
	if (manifest.repoRoot) lines.push(`repoRoot: ${manifest.repoRoot}`);
	if (manifest.taskId) lines.push(`taskId: ${manifest.taskId}`);
	lines.push(...formatBlock("description", manifest.description));
	lines.push(...formatBlock("message", manifest.message));
	lines.push(`createdAt: ${manifest.createdAt}`, `updatedAt: ${manifest.updatedAt}`);
	if (manifest.appliedAt) lines.push(`appliedAt: ${manifest.appliedAt}`);
	if (manifest.droppedAt) lines.push(`droppedAt: ${manifest.droppedAt}`);
	lines.push("files:");
	for (const file of [...manifest.files].sort((a, b) => comparePaths(a.path, b.path))) {
		const details: string[] = [file.op];
		if (file.beforeHash) details.push(`before=${file.beforeHash}`);
		if (file.afterHash) details.push(`after=${file.afterHash}`);
		if (file.mode !== undefined) details.push(`mode=${file.mode.toString(8)}`);
		if (file.size !== undefined) details.push(`size=${file.size}`);
		lines.push(`  - ${file.path} (${details.join(", ")})`);
	}
	if (manifest.conflicts?.length) {
		lines.push("conflicts:");
		for (const conflict of manifest.conflicts) {
			lines.push(`  - ${conflict.path || "<patch>"}: ${conflict.reason}`);
			if (conflict.expectedHash) lines.push(`    expected: ${conflict.expectedHash}`);
			if (conflict.actualHash) lines.push(`    actual: ${conflict.actualHash}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function findEntry(manifest: NativePatchManifest, relativePath: string): NativePatchFileEntry | undefined {
	return manifest.files.find(file => file.path === relativePath);
}

function upsertEntry(manifest: NativePatchManifest, entry: NativePatchFileEntry): void {
	const existingIndex = manifest.files.findIndex(file => file.path === entry.path);
	if (existingIndex >= 0) manifest.files[existingIndex] = entry;
	else manifest.files.push(entry);
	manifest.files.sort((a, b) => comparePaths(a.path, b.path));
}

export async function readPatchVirtualFile(store: PatchStore, patchId: string, relativePath?: string): Promise<string> {
	const manifest = await readNativePatch(store, patchId);
	if (!relativePath || relativePath === "/") return formatManifestText(manifest);
	const normalized = normalizeRelativePath(relativePath);
	const entry = findEntry(manifest, normalized);
	if (!entry) throw new Error(`patch ${patchId} does not contain ${normalized}`);
	if (!entry.afterHash) throw new Error(`patch ${patchId}/${normalized} has no final content`);
	return readBlobText(store, entry.afterHash);
}

function validationMessage(patchId: string, message: string): string {
	return message.startsWith(`patch ${patchId} `) ? message : `patch ${patchId}: ${message}`;
}

export async function writePatchVirtualFile(
	store: PatchStore,
	patchId: string,
	relativePath: string,
	content: string,
	options: WritePatchVirtualFileOptions = {},
): Promise<string> {
	const manifest = await readNativePatch(store, patchId);
	if (manifest.status === "applied") {
		throw new Error(`patch ${patchId} is already applied`);
	}
	if (manifest.status === "dropped") throw new Error(`patch ${patchId} is dropped`);
	const normalized = normalizeRelativePath(relativePath);
	const targetRoot = path.resolve(options.targetRoot ?? manifest.targetRoot);
	const current = await readFileSnapshot(path.join(targetRoot, normalized));
	const contentBytes = encodeText(content);
	const afterHash = await writeBlob(store, contentBytes);
	const existing = findEntry(manifest, normalized);
	const mode = current?.mode ?? existing?.mode ?? 0o100644;
	upsertEntry(manifest, {
		afterHash,
		beforeHash: current?.hash,
		mode,
		op: current ? "modify" : "add",
		path: normalized,
		size: contentBytes.byteLength,
	});
	manifest.status = "pending";
	manifest.updatedAt = nowIso();
	if (manifest.conflicts) {
		manifest.conflicts = manifest.conflicts.filter(conflict => conflict.path !== normalized);
		if (manifest.conflicts.length === 0) delete manifest.conflicts;
	}
	await writeManifestAtomic(store, manifest);
	const validation = await validateManifestAgainstTarget(manifest, {
		cwd: options.cwd,
		repoRoot: options.repoRoot,
		targetRoot,
		signal: options.signal,
	});
	if (!validation.ok) {
		manifest.status = "conflicted";
		manifest.conflicts = validation.conflicts;
		manifest.updatedAt = nowIso();
		await writeManifestAtomic(store, manifest);
	} else {
		manifest.status = "pending";
		delete manifest.conflicts;
		manifest.updatedAt = nowIso();
		await writeManifestAtomic(store, manifest);
	}
	return validationMessage(patchId, validation.message);
}
