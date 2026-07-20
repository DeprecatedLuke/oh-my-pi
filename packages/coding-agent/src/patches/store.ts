import * as nodefs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, resolveEquivalentPath, Snowflake } from "@oh-my-pi/pi-utils";
import type { NativePatchManifest, NativePatchStatus, PatchStore } from "./types";
import { cloneManifest, comparePaths, isPathInsideOrEqual, nowIso, pathExists, readJsonFile } from "./utils";

const STATUS_VALUES: Record<NativePatchStatus, true> = {
	pending: true,
	applied: true,
	dropped: true,
	conflicted: true,
};

function encodeProjectPath(cwd: string): string {
	return `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/**
 * Nearest ancestor of `dir` (inclusive) that contains a `.git` entry, or `dir`
 * itself when none exists. Collapsing to the repository root keeps the patch
 * store key stable regardless of which subdirectory a session was launched
 * from — patches belong to a project, not to a working directory.
 */
function findRepoRootSync(dir: string): string {
	let current = dir;
	// Bounded walk; repositories are never thousands of levels deep.
	for (let depth = 0; depth < 64; depth++) {
		if (nodefs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dir;
}

function storeForKey(keyDir: string): PatchStore {
	const root = path.join(path.dirname(getBlobsDir()), "patches", encodeProjectPath(keyDir));
	return {
		root,
		blobsDir: path.join(root, "blobs"),
		manifestsDir: path.join(root, "manifests"),
	};
}

/**
 * Canonical, project-stable patch store for a working directory: symlinks are
 * resolved (realpath) and the path is collapsed to the enclosing git repository
 * root. Two sessions in the same repo — even launched from a different
 * subdirectory or through a symlinked path — therefore resolve to the same
 * store, so pending patches survive crash/handoff/compaction and reappear in
 * `patch list` instead of vanishing into a cwd-specific bucket.
 */
export function defaultPatchStore(cwd: string): PatchStore {
	return storeForKey(findRepoRootSync(resolveEquivalentPath(path.resolve(cwd))));
}

/**
 * Stores a patch may still live in from before canonical project keying: the
 * raw `path.resolve(cwd)` key used historically, plus its realpath'd form so
 * symlinked launches recover their own pre-existing patches. Only locations
 * that differ from the canonical store are returned; callers probe these as a
 * fallback so already-written patches keep surfacing after the upgrade.
 */
function legacyPatchStores(cwd: string): PatchStore[] {
	const seen = new Set<string>([defaultPatchStore(cwd).root]);
	const stores: PatchStore[] = [];
	for (const keyDir of [path.resolve(cwd), resolveEquivalentPath(path.resolve(cwd))]) {
		const store = storeForKey(keyDir);
		if (seen.has(store.root)) continue;
		seen.add(store.root);
		stores.push(store);
	}
	return stores;
}

export function manifestPath(store: PatchStore, id: string): string {
	if (!id || id.includes("/") || id.includes("\\")) {
		throw new Error(`invalid native patch id: ${id}`);
	}
	return path.join(store.manifestsDir, `${id}.json`);
}

function assertString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`invalid native patch manifest: ${field}`);
	}
}

function validateManifest(value: unknown): NativePatchManifest {
	if (!value || typeof value !== "object") throw new Error("invalid native patch manifest");
	const manifest = value as NativePatchManifest;
	if (manifest.version !== 1) throw new Error("invalid native patch manifest: version");
	assertString(manifest.id, "id");
	assertString(manifest.targetRoot, "targetRoot");
	assertString(manifest.createdAt, "createdAt");
	assertString(manifest.updatedAt, "updatedAt");
	if (!(manifest.status in STATUS_VALUES)) throw new Error("invalid native patch manifest: status");
	if (!Array.isArray(manifest.files)) throw new Error("invalid native patch manifest: files");
	for (const file of manifest.files) {
		assertString(file.path, "files[].path");
		if (file.op !== "add" && file.op !== "modify" && file.op !== "delete") {
			throw new Error(`invalid native patch manifest: ${file.path} op`);
		}
	}
	return manifest;
}

export async function ensureStore(store: PatchStore): Promise<void> {
	await Promise.all([
		fs.mkdir(store.root, { recursive: true }),
		fs.mkdir(store.blobsDir, { recursive: true }),
		fs.mkdir(store.manifestsDir, { recursive: true }),
	]);
}

export async function writeManifestAtomic(
	store: PatchStore,
	manifest: NativePatchManifest,
): Promise<NativePatchManifest> {
	await ensureStore(store);
	const filePath = manifestPath(store, manifest.id);
	const tempPath = path.join(store.manifestsDir, `.${manifest.id}.${Snowflake.next()}.tmp`);
	const text = `${JSON.stringify(manifest, null, "\t")}\n`;
	await Bun.write(tempPath, text);
	await fs.rename(tempPath, filePath);
	return cloneManifest(manifest);
}

type NativePatchScopeOptions = { cwd?: string };

async function collectNativePatches(
	store: PatchStore,
	options: NativePatchScopeOptions = {},
): Promise<NativePatchManifest[]> {
	// Read the canonical store first; legacy per-cwd stores (only resolvable
	// when a cwd is supplied) are probed afterward so patches written before
	// canonical keying still surface. First write of an id wins, so a canonical
	// manifest always shadows a stale legacy copy.
	const manifestDirs = new Set<string>([store.manifestsDir]);
	if (options.cwd) {
		for (const legacy of legacyPatchStores(options.cwd)) manifestDirs.add(legacy.manifestsDir);
	}
	const cwd = options.cwd ? path.resolve(options.cwd) : undefined;
	const byId = new Map<string, NativePatchManifest>();
	for (const dir of manifestDirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const manifest = validateManifest(await readJsonFile<unknown>(path.join(dir, entry)));
			if (byId.has(manifest.id)) continue;
			if (cwd) {
				const targetRoot = path.resolve(manifest.targetRoot);
				const repoRoot = manifest.repoRoot ? path.resolve(manifest.repoRoot) : undefined;
				const related =
					isPathInsideOrEqual(cwd, targetRoot) ||
					isPathInsideOrEqual(targetRoot, cwd) ||
					(repoRoot !== undefined && (isPathInsideOrEqual(cwd, repoRoot) || isPathInsideOrEqual(repoRoot, cwd)));
				if (!related) continue;
			}
			byId.set(manifest.id, manifest);
		}
	}
	const manifests = [...byId.values()];
	manifests.sort((a, b) => {
		const byTime = b.createdAt.localeCompare(a.createdAt);
		return byTime === 0 ? comparePaths(b.id, a.id) : byTime;
	});
	return manifests;
}

export async function listNativePatches(
	store: PatchStore,
	options: { listDropped?: boolean; cwd?: string } = {},
): Promise<NativePatchManifest[]> {
	const manifests = await collectNativePatches(store, options);
	return manifests.filter(
		manifest => manifest.status !== "applied" && (options.listDropped || manifest.status !== "dropped"),
	);
}

export async function searchNativePatches(
	store: PatchStore,
	query: string,
	options: NativePatchScopeOptions = {},
): Promise<NativePatchManifest[]> {
	const manifests = await collectNativePatches(store, options);
	const needle = query.toLowerCase();
	if (needle.length === 0) return manifests;
	return manifests.filter(manifest => {
		const fields = [
			manifest.id,
			manifest.status,
			manifest.description,
			manifest.taskId,
			manifest.message,
			...manifest.files.map(file => file.path),
		];
		return fields.some(field => field?.toLowerCase().includes(needle));
	});
}

/**
 * Locate the store that actually holds patch `id`, checking the canonical
 * project store first and then any legacy per-cwd stores. Falls back to the
 * canonical store so callers always receive a usable handle even when the id
 * does not exist yet.
 */
export async function resolveNativePatchStore(cwd: string, id: string): Promise<PatchStore> {
	const canonical = defaultPatchStore(cwd);
	if (await nativePatchExists(canonical, id)) return canonical;
	for (const legacy of legacyPatchStores(cwd)) {
		if (await nativePatchExists(legacy, id)) return legacy;
	}
	return canonical;
}

export async function readNativePatch(store: PatchStore, id: string): Promise<NativePatchManifest> {
	return validateManifest(await readJsonFile<unknown>(manifestPath(store, id)));
}

export async function writeNativePatchMessage(
	store: PatchStore,
	id: string,
	message: string,
): Promise<NativePatchManifest> {
	const manifest = await readNativePatch(store, id);
	manifest.message = message;
	manifest.updatedAt = nowIso();
	return writeManifestAtomic(store, manifest);
}

export async function dropNativePatch(store: PatchStore, id: string): Promise<NativePatchManifest> {
	const manifest = await readNativePatch(store, id);
	const now = nowIso();
	manifest.status = "dropped";
	manifest.droppedAt = now;
	manifest.updatedAt = now;
	return writeManifestAtomic(store, manifest);
}

export async function nativePatchExists(store: PatchStore, id: string): Promise<boolean> {
	return pathExists(manifestPath(store, id));
}
