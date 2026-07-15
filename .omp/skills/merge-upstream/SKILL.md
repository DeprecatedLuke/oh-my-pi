---
name: merge-upstream
description: Restart and complete an upstream merge in an isolated worktree: fetch and merge tracked upstream, resolve conflicts upstream-first, validate the entire cwd, fast-forward the full result into ../.., and push the fork branch. Use when updating this fork from upstream or restarting a conflicted upstream merge.
---

# Merge Upstream

Merge upstream with a clean restart. Preserve local divergence only where upstream behavior cannot replace it.

## Preconditions

- Run from `.ditto/<id>` isolated merge worktree; this cwd is an independent clone with its own `.git`.
- Treat the entire cwd as scope: packages, docs, locks, native code, generated tracked files.
- Git refs synchronize tracked files only; inspect untracked and ignored files separately.
- Destination `../..` is the real `oh-my-pi-squared` checkout; avoid cwd-vs-absolute-path tree splits.
- Resolve remote and branch from this branch's upstream tracking configuration.
- Record `base=$(git rev-parse HEAD)` before touching the merge.
- Inspect source and destination status before destructive or apply operations.
- NEVER discard unrelated user changes. An interrupted merge? `git merge --abort`.
- No active merge but conflict artifacts remain? Ask before `git reset --hard HEAD`.

## Flow

1. Abort the interrupted merge; confirm `MERGE_HEAD` is absent.
2. Fetch the configured upstream remote with pruning.
3. Merge its tracked branch into the current branch.
4. Conflicts: inspect base, upstream, and local intent; choose upstream by default.
5. Keep local changes only for fork-specific behavior or required compatibility.
6. Remove conflict markers; stage every resolved file; complete the merge commit.
7. Run `bun install` from repository root.
8. Run `bun run build:native` from repository root.
9. Run `bun check`; NEVER invoke `tsc` directly.
10. Stop on any failed command; fix the merge, then rerun its failed validation.

## Apply Verified Cwd

- Compare the merge result with `$base`; review the entire tracked-tree delta.
- Source merge MUST be complete, clean, and validated before landing.
- Destination `../..` MUST have a clean index and no merge in progress.
- Record the destination SHA before landing; reset only this run's recoverable changes.
- Capture `sandbox_root=$(pwd)` and `sandbox_sha=$(git rev-parse HEAD)`.
- Fetch the entire source ref into the destination:

```sh
sandbox_branch=$(git branch --show-current)
git -C ../.. fetch "$sandbox_root" "$sandbox_branch"
git -C ../.. merge --ff-only "$sandbox_sha"
```

- Verify `git -C ../.. rev-parse HEAD` equals `$sandbox_sha`.
- Verify destination status is clean before running destination checks.
- Run `bun install`, `bun run build:native`, and `bun check` in `../..`.
- Failure? Reset destination to its recorded pre-landing SHA; NEVER push.

## Push

- Push only after destination validation succeeds.
- `origin` is the DeprecatedLuke fork; `upstream` is fetch-only.
- Refresh `origin/main`; record `origin_tip=$(git -C ../.. rev-parse origin/main)`.
- If `origin_tip` is an ancestor, push normally: `git -C ../.. push origin main`.
- If history rewrote, use `--force-with-lease=main:$origin_tip`; NEVER blind `--force`.
- Verify `origin/main` equals destination `HEAD` after pushing.
- Report merge commit, upstream revision, conflict decisions, validations, landing SHA, and pushed ref.

<critical>
- Abort an interrupted merge before restarting it.
- Prefer upstream at every conflict unless fork behavior requires local code.
- NEVER run direct `tsc`; use `bun check`.
- Synchronize the entire tracked cwd via ref fast-forward; NEVER stage a patch as final landing.
- Verify source, destination, and `origin/main` SHAs before yielding.
- Push `main` to `origin` only; NEVER push to `upstream`.
- NEVER push before destination validation passes.
</critical>
