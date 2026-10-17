# git_checkpoint

> List the repos with uncommitted changes, then commit only the repos the agent names — the agent-facing form of `omp git checkpoint`.

## Source

- Public tool and schema: `packages/coding-agent/src/tools/git-checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/git-checkpoint.md`
- Shared stage logic (single implementation for tool and CLI): `packages/coding-agent/src/commit/checkpoint.ts`
  - `runCheckpointStage()` — the two-stage decision (`clean` | `listed` | `unmatched` | `committed`)
  - `dirtyRepos()`, `selectDirtyRepos()`, `commitCheckpointRepos()`, `formatDirtyRepoList()`, `formatCheckpointResult()`
  - `createStandaloneCommitDeps()` — model-access fallback for callers without a live session registry
- CLI twin: `packages/coding-agent/src/commands/git.ts` (`omp git checkpoint`); operator bulk path: `packages/coding-agent/src/slash-commands/builtin-session.ts` (`/git checkpoint`)

## Registration / Visibility

- Tool metadata: `name = "git_checkpoint"`, `approval = "write"`, `strict = true`, `loadMode = "discoverable"`.
- No settings gate: `GitCheckpointTool.createIf()` always constructs the tool, so it is registered whenever the session's built-in plan includes it.
- The name is part of `BUILTIN_TOOL_NAMES` (`packages/coding-agent/src/tools/builtin-names.ts`) and the `BUILTIN_TOOLS` factory map (`packages/coding-agent/src/tools/index.ts`).
- Being discoverable and absent from `XDEV_KEEP_TOP_LEVEL`/`XDEV_TRANSPORT_TOOLS`, an ordinary `tools.xdev` session mounts it as `xd://git_checkpoint`: the model reads `xd://git_checkpoint` for docs and executes it by writing `{"repos": [...]}` to that device. Explicitly requested tools stay top-level.
- Distinct from `checkpoint`/`rewind`, which are conversation-context markers and never touch git.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repos` | `string[]` | No | Stage-2 selection: repo names exactly as a bare call listed them (the display label), or a path that resolves to a repo root relative to the session cwd. Omitted or empty runs stage 1. |

## Outputs

One text block plus structured `details`:

| `details.stage` | Trigger | Text | `details` |
| --- | --- | --- | --- |
| `clean` | No repo under the workspace is dirty | `Nothing to commit — all repos are clean.` | `dirty: []`; result flagged `useless` |
| `listed` | `repos` omitted or empty | `Detected repos with changes:` + one `  <label> (<N> files)` line per dirty repo + a line telling the agent to call again with `repos` | `dirty` — every dirty repo with label and file count |
| `unmatched` | At least one requested name matches no dirty repo | `No dirty repo matches: <names>` + the dirty listing + `Nothing was committed.` | `dirty`, `unmatched`; result is an error (`isError`) |
| `committed` | Every requested name matched | One `  <label>: <sha> (<N> files) — <subject>` line per entry, as rendered by `formatCheckpointResult` | `dirty`, `entries` — per-repo `{ repoPath, label, status, sha?, filesChanged, message?, reason?, error? }`; `isError` when any entry `status === "failed"` |

## Flow

1. `execute()` validates cancellation through `untilAborted(signal, …)`, then calls `runCheckpointStage(session.cwd, params.repos ?? [], acquire)`.
2. Stage 1 (`repos` omitted/empty) enumerates dirty repos through `dirtyRepos()`: the nearest enclosing repo plus the unlinked nested repos discovered beneath it, with nested repos excluded from the parent's status so a dirty child does not also mark the parent dirty. Labels are relative to the cwd the listing ran from. **Nothing is staged or committed.**
3. `selectDirtyRepos()` maps names onto the dirty set by presentation label or by resolved path. Any name that matches no dirty repo returns the `unmatched` stage, and no repo is committed.
4. Only when every name matched does the caller-supplied `acquireCommitDeps()` run:
   - the live tool session's `session.modelRegistry` when present, else `createStandaloneCommitDeps(session.cwd, session.settings)` (discover auth storage → `ModelRegistry.refresh()` → `loadCliExtensionProviders()`), released after the commit finishes;
   - `sessionId` from `session.getSessionId?.()`.
5. `commitCheckpointRepos()` handles each selected repo independently: nested unlinked repos are excluded from staging, `git add -A` stages the rest (honoring `.gitignore`), the cached diff is sent to the commit-message generator, and `git commit` runs with the generated message. The returned sha is the short HEAD.
6. A repo whose staging comes up empty is reported `skipped` (`reason: "no-changes"`); a repo that throws is reported `failed` with its error and does not stop its siblings.

## Side Effects

- Creates real local commits in the named repos — including untracked files, because staging is `git add -A` over the whole repo. Naming a repo therefore stages **every** dirty file in it, not only the agent's edits.
- Requests a model call for each committed repo's message (session model registry, or the standalone registry built the same way the CLI builds it).
- No push, fetch, rebase, amend, or remote interaction happens anywhere in this flow.

## Limits & Caps

- One commit per named repo per call; there is no message override, no per-file selection, and no `--amend`.
- An unmatched name aborts the whole call rather than committing the names that did match.
- Nothing is remembered between calls: stage 2 re-enumerates dirty repos and re-validates names against the current tree.
- Empty generation (`""` from the commit-message generator) is a hard failure for that repo: `Could not generate a commit message.`

## Errors

- Unmatched selection → non-throwing error result listing the unmatched names and the dirty repos.
- Any `failed` entry → the result is flagged `isError` and includes each entry's error text; successful siblings remain committed.
- Environment failures (git unavailable, not a repository, no model access) surface through the underlying helpers: `dirtyRepos()` returns `[]` when no repo encloses the cwd, and auth/model construction failures propagate out of `createStandaloneCommitDeps()`.

## Notes

- `omp git checkpoint` prints the same stage text (`Detected repos with changes:`, `Nothing to commit — all repos are clean.`, `No dirty repo matches: …`) and uses the same exit codes, because both surfaces call `runCheckpointStage`.
- `/git checkpoint` is the operator path: the user owns every dirty repo, so that command commits them all in one step without the selection stage.
