/**
 * `detectGitRepos` scope: the `git` checkpoint/status flow must resolve the repo
 * that `cwd` belongs to (the nearest enclosing `.git`) and never climb to an
 * outer parent repo. Regression for a checkout nested inside another repo (e.g.
 * a worktree under a superproject) where the old "outermost root" selection swept
 * the parent's sibling repos into the checkpoint.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectGitRepos } from "@oh-my-pi/pi-coding-agent/patches";

// Layout (each `.git` is a bare directory — `detectGitRepos` only stats `.git`):
//   parent/.git                  ← superproject
//   parent/modules/.git          ← sibling repo
//   parent/sdk/.git              ← sibling repo
//   parent/.ditto/wt/.git        ← the checkout the agent runs in
//   parent/modules/src           ← a plain subdirectory (no .git)
let root = "";
let parent = "";
let modules = "";
let sdk = "";
let checkout = "";

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-scope-")));
	parent = path.join(root, "parent");
	modules = path.join(parent, "modules");
	sdk = path.join(parent, "sdk");
	checkout = path.join(parent, ".ditto", "wt");
	await Promise.all([
		fs.mkdir(path.join(parent, ".git"), { recursive: true }),
		fs.mkdir(path.join(modules, ".git"), { recursive: true }),
		fs.mkdir(path.join(sdk, ".git"), { recursive: true }),
		fs.mkdir(path.join(checkout, ".git"), { recursive: true }),
		fs.mkdir(path.join(modules, "src"), { recursive: true }),
	]);
});

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("detectGitRepos scope", () => {
	it("scopes to the nested checkout's own repo, not the enclosing parent or its siblings", async () => {
		const detected = await detectGitRepos(checkout);
		expect(detected).not.toBeNull();
		// Root is the checkout itself — it does NOT climb to `parent`.
		expect(detected?.root).toBe(checkout);
		// And the swept set is just the checkout: no parent, modules, or sdk.
		expect(detected?.repos).toEqual([checkout]);
	});

	it("discovers nested sibling repos downward but prunes dot-dirs like .ditto overlays", async () => {
		const detected = await detectGitRepos(parent);
		expect(detected?.root).toBe(parent);
		// Root + sibling repos nested beneath it. The `.ditto/wt` overlay checkout is
		// pruned: dot-prefixed dirs (task worktree/overlay internals) and node_modules are
		// never swept into the parent's checkpoint. Otherwise `git add` inside the overlay
		// hits the overlay's own .gitignore and the checkpoint fails (e.g. ignored
		// backend/cluster/frontend paths).
		expect(new Set(detected?.repos)).toEqual(new Set([parent, modules, sdk]));
		expect(detected?.repos).not.toContain(checkout);
	});

	it("resolves a plain subdirectory up to its owning repo (and no further)", async () => {
		const detected = await detectGitRepos(path.join(modules, "src"));
		// Climbs from the subdir to `modules`, stops there — never reaches `parent`.
		expect(detected?.root).toBe(modules);
		expect(detected?.repos).toEqual([modules]);
	});

	it("returns null when cwd is under no git repo", async () => {
		const detached = path.join(root, "no-repo-here");
		await fs.mkdir(detached, { recursive: true });
		expect(await detectGitRepos(detached)).toBeNull();
	});
});
