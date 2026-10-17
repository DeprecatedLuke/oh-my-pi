Commits uncommitted work as local, WIP checkpoints so a milestone is recoverable. Two stages, in this order — never one call:

- **Omit `repos`** (or pass `[]`) — list every repo under the workspace with uncommitted changes. Nothing is committed, and the reply names each repo with its file count.
- **Pass `repos: ["<name>", …]`** — commit exactly those repos, each with a generated message. Names must match the stage-one listing verbatim (a path resolving to a repo root also works). Every name must match a dirty repo; one unknown name aborts the whole call and commits nothing, so never guess a name — list first.

Committing a named repo stages **all** of its dirty files — including edits you did not make. Name a repo only when every uncommitted change in it is yours; when a repo mixes your work with the user's, leave it alone and tell the user instead.

Checkpoint at scope or milestone boundaries — a finished feature, a green test run, a coherent refactor step — not after every edit. One checkpoint per completed unit of work; a stream of single-edit commits buries the history it exists to preserve.

Commits are local only. Never push, never rebase, never amend, never touch a remote, and never rewrite an existing commit; the user decides when work leaves the machine.

The reply reports each repo's commit sha, file count, and subject line. Any failed entry surfaces as a tool error: read which repo failed and why before retrying — a partial commit is normal when one repo of several fails.
