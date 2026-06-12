export type NativePatchStatus = "pending" | "applied" | "dropped" | "conflicted";
export type NativePatchFileOp = "add" | "modify" | "delete";

export interface NativePatchFileEntry {
	path: string;
	op: NativePatchFileOp;
	beforeHash?: string;
	afterHash?: string;
	mode?: number;
	size?: number;
}

export interface NativePatchConflict {
	path: string;
	reason: string;
	expectedHash?: string;
	actualHash?: string;
	/**
	 * Set when `applyNativePatch` materialized diff3-style conflict markers
	 * in the target file at `path`. The agent resolves the markers via
	 * `conflict://<N>` (see `conflict-detect.ts`) and re-runs `patch apply`;
	 * the retry snapshots the (now markerless) disk content as the entry's
	 * final state and stages it normally. When this flag is absent the
	 * conflict is "plain" (structural, binary, or unmergeable) and the
	 * patch must be edited or dropped instead.
	 */
	markersWritten?: boolean;
}

export interface NativePatchManifest {
	version: 1;
	id: string;
	taskId?: string;
	description?: string;
	targetRoot: string;
	repoRoot?: string;
	createdAt: string;
	updatedAt: string;
	status: NativePatchStatus;
	files: NativePatchFileEntry[];
	message?: string;
	conflicts?: NativePatchConflict[];
	appliedAt?: string;
	droppedAt?: string;
}

export interface PatchStore {
	root: string;
	manifestsDir: string;
	blobsDir: string;
}

export interface CreateNativePatchInput {
	store: PatchStore;
	baselineRoot: string;
	changedRoot: string;
	targetRoot: string;
	repoRoot?: string;
	id?: string;
	taskId?: string;
	description?: string;
	message?: string;
}

export interface CreateNativePatchResult {
	manifest: NativePatchManifest;
	store: PatchStore;
	empty: boolean;
	blobCount: number;
}

export interface ApplyNativePatchOptions {
	cwd?: string;
	targetRoot?: string;
	repoRoot?: string;
	repoLabel?: string;
	signal?: AbortSignal;
	generateMessage?: (manifest: NativePatchManifest) => Promise<string | null | undefined> | string | null | undefined;
}

export interface ApplyNativePatchResult {
	manifest: NativePatchManifest;
	applied: boolean;
	committed: boolean;
	commit?: string;
	files: NativePatchFileEntry[];
}

export interface PatchValidationResult {
	ok: boolean;
	valid: boolean;
	manifest: NativePatchManifest;
	conflicts: NativePatchConflict[];
	dirty?: boolean;
	message: string;
}

export interface WritePatchVirtualFileOptions {
	cwd?: string;
	targetRoot?: string;
	repoRoot?: string;
	signal?: AbortSignal;
}
