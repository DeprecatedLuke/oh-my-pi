---
name: merge-upstream
description: Restart and complete an upstream merge in an isolated worktree: discard only the interrupted merge, fetch the configured upstream remote, merge its tracked branch, resolve conflicts upstream-first, install dependencies, build native bindings, type-check, apply the verified delta to ../.., then push. Use when updating this fork from upstream or restarting a conflicted upstream merge.
---

# Merge Upstream

Merge upstream with a clean restart. Preserve local divergence only where upstream behavior cannot replace it.

## Preconditions

- Run from the isolated merge worktree.
- Destination worktree: `../..`.
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

## Apply Verified Delta

- Compare the merge result with `$base`; review the exact delta.
- Destination must have no merge in progress and a clean index.
- Create a binary patch: `git diff --binary "$base..HEAD" > /tmp/merge-upstream.patch`.
- Apply at destination: `git -C ../.. apply --3way --index /tmp/merge-upstream.patch`.
- Verify destination contains the expected staged delta.
- Run `bun install`, `bun run build:native`, and `bun check` in `../..`.
- Failure? reverse the destination application before retrying; NEVER push partial output.

## Push

- Push only after destination validation succeeds.
- Push the destination branch's configured upstream; NEVER guess a remote or branch.
- Report merge commit, upstream revision, conflict decisions, validations, destination application, and pushed ref.

<critical>
- Abort an interrupted merge before restarting it.
- Prefer upstream at every conflict unless fork behavior requires local code.
- NEVER run direct `tsc`; use `bun check`.
- Apply only the verified `$base..HEAD` delta to `../..`.
- NEVER push before destination validation passes.
</critical>
