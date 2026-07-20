import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyNativePatch,
	createNativePatch,
	defaultPatchStore,
	dropNativePatch,
	listNativePatches,
	readPatchVirtualFile,
	resolveNativePatchStore,
	searchNativePatches,
	validateNativePatch,
	writeNativePatchMessage,
	writePatchVirtualFile,
} from "../src/patches";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function initGitRepo(repo: string): Promise<void> {
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
}

async function createPatchFixture(prefix: string, options?: { git?: boolean }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	const target = path.join(root, "target");
	const baseline = path.join(root, "baseline");
	const changed = path.join(root, "changed");
	const storeRoot = path.join(root, "store");
	await fs.mkdir(target, { recursive: true });
	await fs.mkdir(baseline, { recursive: true });
	await fs.mkdir(changed, { recursive: true });
	await fs.writeFile(path.join(target, "a.txt"), "old\n");
	await fs.writeFile(path.join(baseline, "a.txt"), "old\n");
	await fs.writeFile(path.join(changed, "a.txt"), "new\n");
	if (options?.git) {
		await initGitRepo(target);
	}
	const store = defaultPatchStore(storeRoot);
	const result = await createNativePatch({
		store,
		baselineRoot: baseline,
		changedRoot: changed,
		targetRoot: target,
		taskId: "PatchTask",
		description: "update a.txt",
	});
	return { root, target, baseline, changed, storeRoot, store, manifest: result.manifest };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("native patch store", () => {
	it("persists pending patches across store instances and drop hides them by default", async () => {
		const fixture = await createPatchFixture("omp-native-patch-store-");
		const reopenedStore = defaultPatchStore(fixture.storeRoot);

		const pending = await listNativePatches(reopenedStore, { cwd: fixture.target });
		expect(pending.map(patch => patch.id)).toContain(fixture.manifest.id);
		expect(pending.find(patch => patch.id === fixture.manifest.id)?.status).toBe("pending");

		await dropNativePatch(reopenedStore, fixture.manifest.id);

		expect((await listNativePatches(reopenedStore, { cwd: fixture.target })).map(patch => patch.id)).not.toContain(
			fixture.manifest.id,
		);
		const withDropped = await listNativePatches(reopenedStore, { cwd: fixture.target, listDropped: true });
		expect(withDropped.find(patch => patch.id === fixture.manifest.id)?.status).toBe("dropped");
	});

	it("fails dirty Git apply before mutating with the exact dirty-repo message", async () => {
		const fixture = await createPatchFixture("omp-native-patch-dirty-", { git: true });
		await fs.writeFile(path.join(fixture.target, "dirty.txt"), "dirty\n");

		await expect(
			applyNativePatch(fixture.store, fixture.manifest.id, {
				cwd: fixture.target,
				generateMessage: async () => "test: apply native patch",
			}),
		).rejects.toThrow(
			`failed to apply ./${fixture.manifest.id}: target repo is dirty, git commit ${fixture.target} and reapply`,
		);
		expect(await fs.readFile(path.join(fixture.target, "a.txt"), "utf8")).toBe("old\n");
	});

	it("applies no-Git targets directly without commit-message generation", async () => {
		const fixture = await createPatchFixture("omp-native-patch-nogit-");
		let generated = false;

		const result = await applyNativePatch(fixture.store, fixture.manifest.id, {
			cwd: fixture.target,
			generateMessage: async () => {
				generated = true;
				return "test: should not be used";
			},
		});

		expect(generated).toBe(false);
		expect(result.applied).toBe(true);
		expect(result.committed).toBe(false);
		expect(result.commit).toBeUndefined();
		expect(result.manifest.status).toBe("applied");
		expect(result.manifest.appliedAt).toEqual(expect.any(String));
		expect(await fs.readFile(path.join(fixture.target, "a.txt"), "utf8")).toBe("new\n");
		const listed = await listNativePatches(fixture.store, { cwd: fixture.target });
		expect(listed.map(patch => patch.id)).not.toContain(fixture.manifest.id);
		const listedWithDropped = await listNativePatches(fixture.store, {
			cwd: fixture.target,
			listDropped: true,
		});
		expect(listedWithDropped.map(patch => patch.id)).not.toContain(fixture.manifest.id);
	});

	it("searches applied and dropped history while list excludes applied patches", async () => {
		const fixture = await createPatchFixture("omp-native-patch-history-");
		await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });

		const droppedBaseline = path.join(fixture.root, "dropped-baseline");
		const droppedChanged = path.join(fixture.root, "dropped-changed");
		await fs.mkdir(droppedBaseline, { recursive: true });
		await fs.mkdir(droppedChanged, { recursive: true });
		await fs.writeFile(path.join(droppedBaseline, "a.txt"), "new\n");
		await fs.writeFile(path.join(droppedChanged, "a.txt"), "dropped\n");
		const droppedPatch = await createNativePatch({
			store: fixture.store,
			baselineRoot: droppedBaseline,
			changedRoot: droppedChanged,
			targetRoot: fixture.target,
			taskId: "DroppedTask",
			description: "archive a.txt",
		});
		await dropNativePatch(fixture.store, droppedPatch.manifest.id);

		const appliedMatches = await searchNativePatches(fixture.store, "UPDATE A.TXT", {
			cwd: fixture.target,
		});
		expect(appliedMatches.map(patch => patch.id)).toContain(fixture.manifest.id);
		expect(appliedMatches.find(patch => patch.id === fixture.manifest.id)?.status).toBe("applied");
		expect(appliedMatches.map(patch => patch.id)).not.toContain(droppedPatch.manifest.id);

		const droppedMatches = await searchNativePatches(fixture.store, "DROPPED", { cwd: fixture.target });
		expect(droppedMatches.find(patch => patch.id === droppedPatch.manifest.id)?.status).toBe("dropped");
		expect(droppedMatches.map(patch => patch.id)).not.toContain(fixture.manifest.id);

		expect(await searchNativePatches(fixture.store, "missing patch metadata", { cwd: fixture.target })).toEqual([]);
	});

	it("requires an explicit or generated commit message before Git patch apply", async () => {
		const fixture = await createPatchFixture("omp-native-patch-message-", { git: true });

		await expect(applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target })).rejects.toThrow(
			`failed to apply ./${fixture.manifest.id}: commit message unavailable, populate message: and retry`,
		);
		expect(await fs.readFile(path.join(fixture.target, "a.txt"), "utf8")).toBe("old\n");

		await writeNativePatchMessage(fixture.store, fixture.manifest.id, "test: apply native patch");
		const result = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(result.applied).toBe(true);
		expect(result.committed).toBe(true);
		expect(result.commit).toEqual(expect.any(String));
		expect(await runGit(fixture.target, ["log", "-1", "--format=%s"])).toBe("test: apply native patch");
	});

	it("revalidates patch:// file edits and reports conflicts against target drift", async () => {
		const fixture = await createPatchFixture("omp-native-patch-url-");
		expect(await readPatchVirtualFile(fixture.store, fixture.manifest.id, "a.txt")).toBe("new\n");

		await fs.writeFile(path.join(fixture.target, "a.txt"), "drift\n");
		const message = await writePatchVirtualFile(fixture.store, fixture.manifest.id, "a.txt", "resolved\n", {
			targetRoot: fixture.target,
		});
		expect(message.toLowerCase()).toContain("valid");
		expect(await readPatchVirtualFile(fixture.store, fixture.manifest.id, "a.txt")).toBe("resolved\n");
		expect(
			(await validateNativePatch(fixture.store, fixture.manifest.id, { targetRoot: fixture.target })).valid,
		).toBe(true);

		await fs.rm(path.join(fixture.target, "a.txt"));
		const validation = await validateNativePatch(fixture.store, fixture.manifest.id, { targetRoot: fixture.target });
		expect(validation.valid).toBe(false);
		expect(JSON.stringify(validation)).toContain("a.txt");
	});
});

async function createMultilinePatchFixture(prefix: string, options?: { git?: boolean }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	const target = path.join(root, "target");
	const baseline = path.join(root, "baseline");
	const changed = path.join(root, "changed");
	const storeRoot = path.join(root, "store");
	await fs.mkdir(target, { recursive: true });
	await fs.mkdir(baseline, { recursive: true });
	await fs.mkdir(changed, { recursive: true });
	const baselineText = "line a\nline b\nline c\nline d\n";
	await fs.writeFile(path.join(target, "a.txt"), baselineText);
	await fs.writeFile(path.join(baseline, "a.txt"), baselineText);
	await fs.writeFile(path.join(changed, "a.txt"), "line a\nline b PATCHED\nline c\nline d\n");
	if (options?.git) {
		await initGitRepo(target);
	}
	const store = defaultPatchStore(storeRoot);
	const result = await createNativePatch({
		store,
		baselineRoot: baseline,
		changedRoot: changed,
		targetRoot: target,
		taskId: "PatchTask",
		description: "patch line b",
	});
	return { root, target, baseline, changed, storeRoot, store, manifest: result.manifest };
}

describe("native patch conflict markers", () => {
	it("materializes diff3 conflict markers in the target when target drifted from patch baseline", async () => {
		const fixture = await createMultilinePatchFixture("omp-native-patch-markers-");
		await fs.writeFile(path.join(fixture.target, "a.txt"), "line a\nline b CURRENT\nline c\nline d\n");

		const result = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(result.applied).toBe(false);
		expect(result.manifest.status).toBe("conflicted");
		const conflicts = result.manifest.conflicts ?? [];
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ path: "a.txt", markersWritten: true });

		const onDisk = await fs.readFile(path.join(fixture.target, "a.txt"), "utf8");
		expect(onDisk).toContain("<<<<<<<");
		expect(onDisk).toContain("|||||||");
		expect(onDisk).toContain("=======");
		expect(onDisk).toContain(">>>>>>>");
		expect(onDisk).toContain("line b PATCHED");
		expect(onDisk).toContain("line b CURRENT");
	});

	it("re-apply after marker resolution snapshots disk content and commits", async () => {
		const fixture = await createMultilinePatchFixture("omp-native-patch-resolve-", { git: true });
		await fs.writeFile(path.join(fixture.target, "a.txt"), "line a\nline b CURRENT\nline c\nline d\n");
		await runGit(fixture.target, ["add", "a.txt"]);
		await runGit(fixture.target, ["commit", "-m", "drift"]);

		const first = await applyNativePatch(fixture.store, fixture.manifest.id, {
			cwd: fixture.target,
			generateMessage: async () => "test: resolved patch",
		});
		expect(first.applied).toBe(false);
		expect(first.manifest.status).toBe("conflicted");
		expect(first.manifest.conflicts?.[0]?.markersWritten).toBe(true);

		const resolved = "line a\nline b MERGED BY HUMAN\nline c\nline d\n";
		await fs.writeFile(path.join(fixture.target, "a.txt"), resolved);

		const second = await applyNativePatch(fixture.store, fixture.manifest.id, {
			cwd: fixture.target,
			generateMessage: async () => "test: resolved patch",
		});
		expect(second.applied).toBe(true);
		expect(second.committed).toBe(true);
		expect(second.manifest.status).toBe("applied");
		expect(await fs.readFile(path.join(fixture.target, "a.txt"), "utf8")).toBe(resolved);
		expect(await runGit(fixture.target, ["log", "-1", "--format=%s"])).toBe("test: resolved patch");
	});

	it("re-apply reports remaining markers when resolution is incomplete", async () => {
		const fixture = await createMultilinePatchFixture("omp-native-patch-stillmarkers-");
		await fs.writeFile(path.join(fixture.target, "a.txt"), "line a\nline b CURRENT\nline c\nline d\n");

		const first = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(first.manifest.conflicts?.[0]?.markersWritten).toBe(true);
		// Agent did NOT clean markers — disk still has them.

		const second = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(second.applied).toBe(false);
		expect(second.manifest.status).toBe("conflicted");
		const conflict = second.manifest.conflicts?.[0];
		expect(conflict?.markersWritten).toBe(true);
		expect(conflict?.reason).toContain("unresolved conflict markers remain");
	});

	it("blocks other patch applications while marker-resolution lock is pending", async () => {
		const fixture = await createMultilinePatchFixture("omp-native-patch-lock-");
		await fs.writeFile(path.join(fixture.target, "a.txt"), "line a\nline b CURRENT\nline c\nline d\n");

		const first = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(first.applied).toBe(false);
		expect(first.manifest.conflicts?.[0]?.markersWritten).toBe(true);

		const baseline2 = path.join(fixture.root, "baseline2");
		const changed2 = path.join(fixture.root, "changed2");
		await fs.mkdir(baseline2, { recursive: true });
		await fs.mkdir(changed2, { recursive: true });
		await fs.writeFile(path.join(fixture.target, "b.txt"), "old b\n");
		await fs.writeFile(path.join(baseline2, "b.txt"), "old b\n");
		await fs.writeFile(path.join(changed2, "b.txt"), "new b\n");
		const secondPatch = await createNativePatch({
			store: fixture.store,
			baselineRoot: baseline2,
			changedRoot: changed2,
			targetRoot: fixture.target,
			taskId: "SecondPatchTask",
			description: "update b.txt",
		});

		await expect(applyNativePatch(fixture.store, secondPatch.manifest.id, { cwd: fixture.target })).rejects.toThrow(
			`target is locked by unresolved patch ${fixture.manifest.id}`,
		);
		expect(await fs.readFile(path.join(fixture.target, "b.txt"), "utf8")).toBe("old b\n");
	});

	it("falls back to a plain (markerless) conflict for binary content", async () => {
		const fixture = await createMultilinePatchFixture("omp-native-patch-binary-");
		// Overwrite the target with a NUL byte so canMergeAsText rejects it.
		await fs.writeFile(path.join(fixture.target, "a.txt"), new Uint8Array([0, 1, 2, 3, 4]));

		const result = await applyNativePatch(fixture.store, fixture.manifest.id, { cwd: fixture.target });
		expect(result.applied).toBe(false);
		const conflict = result.manifest.conflicts?.[0];
		expect(conflict?.markersWritten).toBeFalsy();
		const diskBytes = await fs.readFile(path.join(fixture.target, "a.txt"));
		expect(diskBytes[0]).toBe(0); // unchanged — no markers were materialized
	});
});

describe("native patch store project keying", () => {
	async function seedRepoPatch(repo: string, root: string, taskId: string) {
		const baseline = path.join(root, `${taskId}-baseline`);
		const changed = path.join(root, `${taskId}-changed`);
		await fs.mkdir(baseline, { recursive: true });
		await fs.mkdir(changed, { recursive: true });
		await fs.writeFile(path.join(baseline, "a.txt"), "old\n");
		await fs.writeFile(path.join(changed, "a.txt"), "new\n");
		const store = defaultPatchStore(repo);
		tempDirs.push(store.root);
		const created = await createNativePatch({
			store,
			baselineRoot: baseline,
			changedRoot: changed,
			targetRoot: repo,
			repoRoot: repo,
			taskId,
			description: `${taskId} patch`,
		});
		return { store, id: created.manifest.id };
	}

	it("lists a repo's patch when invoked from a subdirectory of the same repo", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-subdir-"));
		tempDirs.push(root);
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		await runGit(repo, ["init", "-b", "main"]);
		const { id } = await seedRepoPatch(repo, root, "SubdirTask");

		const subdir = path.join(repo, "src", "deep");
		await fs.mkdir(subdir, { recursive: true });
		const listed = await listNativePatches(defaultPatchStore(subdir), { cwd: subdir });
		expect(listed.map(patch => patch.id)).toContain(id);
		expect((await resolveNativePatchStore(subdir, id)).root).toBe(defaultPatchStore(repo).root);
	});

	it("lists a repo's patch when the cwd reaches it through a symlinked path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-symlink-"));
		tempDirs.push(root);
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		await runGit(repo, ["init", "-b", "main"]);
		const { id } = await seedRepoPatch(repo, root, "SymlinkTask");

		const link = path.join(root, "link");
		await fs.symlink(repo, link);
		const listed = await listNativePatches(defaultPatchStore(link), { cwd: link });
		expect(listed.map(patch => patch.id)).toContain(id);
	});

	it("recovers a patch filed under a legacy per-cwd store after a git root appears above it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-legacy-"));
		tempDirs.push(root);
		const subdir = path.join(root, "sub");
		await fs.mkdir(subdir, { recursive: true });
		const baseline = path.join(root, "baseline");
		const changed = path.join(root, "changed");
		await fs.mkdir(baseline, { recursive: true });
		await fs.mkdir(changed, { recursive: true });
		await fs.writeFile(path.join(baseline, "a.txt"), "old\n");
		await fs.writeFile(path.join(changed, "a.txt"), "new\n");

		// No git root yet, so the subdir keys to itself — the historical per-cwd layout.
		const legacyStore = defaultPatchStore(subdir);
		tempDirs.push(legacyStore.root);
		const created = await createNativePatch({
			store: legacyStore,
			baselineRoot: baseline,
			changedRoot: changed,
			targetRoot: subdir,
			taskId: "LegacyTask",
			description: "legacy patch",
		});

		// A git root now sits above the subdir, so the canonical key collapses upward.
		await runGit(root, ["init", "-b", "main"]);
		const canonicalStore = defaultPatchStore(subdir);
		tempDirs.push(canonicalStore.root);
		expect(canonicalStore.root).not.toBe(legacyStore.root);

		const listed = await listNativePatches(canonicalStore, { cwd: subdir });
		expect(listed.map(patch => patch.id)).toContain(created.manifest.id);
		expect((await resolveNativePatchStore(subdir, created.manifest.id)).root).toBe(legacyStore.root);
	});
});

async function createIgnoredFixture(prefix: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	const target = path.join(root, "target");
	const baseline = path.join(root, "baseline");
	const changed = path.join(root, "changed");
	const storeRoot = path.join(root, "store");
	await fs.mkdir(target, { recursive: true });
	await fs.mkdir(baseline, { recursive: true });
	await fs.mkdir(changed, { recursive: true });
	return { root, target, baseline, changed, store: defaultPatchStore(storeRoot) };
}

describe("gitignored targets", () => {
	it("applies a gitignored target to disk without staging/committing, even on a dirty repo", async () => {
		const { target, baseline, changed, store } = await createIgnoredFixture("omp-native-patch-ignored-");
		await fs.writeFile(path.join(target, ".gitignore"), "ignored/\n");
		await fs.writeFile(path.join(target, "keep.txt"), "keep\n");
		await initGitRepo(target);
		// Unrelated tracked dirt — must NOT block an all-ignored patch.
		await fs.writeFile(path.join(target, "keep.txt"), "dirty\n");
		// baseline empty; changed adds a gitignored file.
		await fs.mkdir(path.join(changed, "ignored"), { recursive: true });
		await fs.writeFile(path.join(changed, "ignored", "note.md"), "hello\n");

		const created = await createNativePatch({
			store,
			baselineRoot: baseline,
			changedRoot: changed,
			targetRoot: target,
			repoRoot: target,
			taskId: "IgnoredTask",
			description: "add ignored note",
		});
		const result = await applyNativePatch(store, created.manifest.id, {
			cwd: target,
			targetRoot: target,
			repoRoot: target,
			repoLabel: "repo",
			generateMessage: async () => "msg",
		});

		expect(result.applied).toBe(true);
		expect(result.committed).toBe(false);
		expect(result.commit).toBeUndefined();
		expect(result.manifest.status).toBe("applied");
		expect(await fs.readFile(path.join(target, "ignored", "note.md"), "utf8")).toBe("hello\n");
		// Written to disk but never tracked by git.
		expect(await runGit(target, ["ls-files", "ignored/note.md"])).toBe("");
		// The unrelated tracked dirt is preserved untouched.
		expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("dirty\n");
	});

	it("commits tracked files but writes gitignored siblings to disk (mixed patch)", async () => {
		const { target, baseline, changed, store } = await createIgnoredFixture("omp-native-patch-mixed-");
		await fs.writeFile(path.join(target, ".gitignore"), "ignored/\n");
		await initGitRepo(target);
		// baseline empty; changed adds one tracked file and one gitignored sibling.
		await fs.writeFile(path.join(changed, "tracked.txt"), "t\n");
		await fs.mkdir(path.join(changed, "ignored"), { recursive: true });
		await fs.writeFile(path.join(changed, "ignored", "note.md"), "i\n");

		const created = await createNativePatch({
			store,
			baselineRoot: baseline,
			changedRoot: changed,
			targetRoot: target,
			repoRoot: target,
			taskId: "MixedTask",
			description: "add tracked and ignored",
		});
		const result = await applyNativePatch(store, created.manifest.id, {
			cwd: target,
			targetRoot: target,
			repoRoot: target,
			repoLabel: "repo",
			generateMessage: async () => "msg",
		});

		expect(result.applied).toBe(true);
		expect(result.committed).toBe(true);
		expect(result.commit).toEqual(expect.any(String));
		const tracked = (await runGit(target, ["ls-files"])).split("\n");
		expect(tracked).toContain("tracked.txt");
		expect(tracked).not.toContain("ignored/note.md");
		// Both files land on disk with their content; only the tracked one is committed.
		expect(await fs.readFile(path.join(target, "tracked.txt"), "utf8")).toBe("t\n");
		expect(await fs.readFile(path.join(target, "ignored", "note.md"), "utf8")).toBe("i\n");
	});
});
