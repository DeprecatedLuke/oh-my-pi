Manage durable native patches produced by isolated subagents.

<parameters>
```ts
type Input =
  | { op: "list"; list_dropped?: boolean }
  | { op: "search"; query: string }
  | { op: "apply"; patch: string; message?: string }
  | { op: "reapply"; patch: string; message?: string }
  | { op: "drop"; patch: string };
</parameters>

<behavior>
- `list` shows pending/conflicted patches by default. Set `list_dropped` to include dropped history; applied patches are never listed.
- `search` performs a case-insensitive historical search across patch ids, statuses, descriptions, task ids, messages, and file paths. Results include pending, conflicted, applied, and dropped patches.
- `apply` applies one patch. Clean Git repos are staged and committed; no-Git targets are edited directly.
- `reapply` finalizes a conflicted patch after marker resolution, then commits/unlocks it.
- Dirty Git targets fail before mutation unless reapplying that patch's own marker-resolution lock. Checkpoint or commit unrelated dirty work, then retry.
- `drop` marks a patch dropped without applying it.
- Patch records survive restarts; search can find applied and dropped history.
- Pending/conflicted patches may trigger `<system-reminder>` follow-ups when no background jobs are active.
</behavior>

<conflict-resolution>
- When `apply` finds the target diverged from the patch's baseline (3-way conflict), it materializes diff3-style `<<<<<<< patched / ||||||| baseline / ======= / >>>>>>> current` markers in the target file itself and returns `applied: false` with `conflicts[].markersWritten = true`.
- Resolve each marker block via the standard conflict flow: `read <path>` registers `conflict://<N>` IDs; `write conflict://<N>` (or `conflict://*` for bulk) replaces the region with your chosen content (use `@ours`, `@theirs`, `@base`, `@both` shorthand if useful).
- Once every marker block is resolved, run `reapply`. The retry snapshots the resolved on-disk content as the patch's final state and (for Git targets) stages + commits normally, releasing the patch lock.
- Plain conflicts (binary content, missing target, structural) are NOT materialized as markers. For those, edit `patch://<patchId>/<file>` to align with the new disk state or `drop` the patch.
- While a marker-written conflict is pending, the target is locked: apply/reapply the locked patch before applying unrelated patches.
</conflict-resolution>

<patch-urls>
- `patch://<patchId>` reads the patch manifest/status.
- `patch://<patchId>/<file>` reads the patched file content.
- Edit `patch://<patchId>/<file>` only for plain (markerless) conflicts; for markers-written conflicts, resolve via `conflict://<N>` in the target file instead.
</patch-urls>

<examples>
# List active patches
`patch {"op":"list"}`

# Search all patch history
`patch {"op":"search","query":"auth"}`

# Apply with explicit Git commit message
`patch {"op":"apply","patch":"task_123","message":"fix: apply auth task patch"}`

# Finalize after resolving conflict:// markers
`patch {"op":"reapply","patch":"task_123","message":"fix: apply auth task patch"}`

# Drop an obsolete patch
`patch {"op":"drop","patch":"task_123"}`
</examples>

<critical>
- You MUST resolve pending/conflicted patches before continuing unrelated work.
- You SHOULD inspect conflicts through `patch://` URLs.
- You NEVER edit patch store files directly.
</critical>
