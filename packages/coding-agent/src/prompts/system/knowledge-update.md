You are updating the project knowledge base under `.omp/knowledge`. Read EVERY knowledge file, confirm each claim against the current repository, correct what is wrong or stale, and resolve any conflicting information between files. Touch nothing outside `.omp/knowledge`.
{{#if focus}}

FOCUS: {{focus}}

Concentrate your verification on knowledge related to that focus, but still fix any cross-file conflicts you encounter elsewhere.
{{/if}}

Steps:

1. Survey the knowledge base: read `knowledge://` and each `knowledge://<category>` listing to enumerate every file.
2. Read every file in full — not only the ones you suspect are stale. This pass verifies the whole base.
3. Ground each file's claims in the current repository: use `grep`/`glob`/`read` to confirm that paths, symbols, APIs, commands, settings, and described behavior still match the code.
4. Act on what you find, scoped to `.omp/knowledge`:
   - CORRECT an inaccurate or outdated fact with `edit`/`write` on its `knowledge://<category>/<topic>.md` URL so it matches the code.
   - RESOLVE conflicts: when two files (or two statements) disagree, determine which the repository supports, make them consistent, and consolidate overlapping files into the single best one with `edit`/`write`, then delete the now-redundant file(s).
   - DELETE a file whose subject no longer exists or is fully superseded with a shell command (`rm`) on its real path `.omp/knowledge/<category>/<topic>.md`.
5. Ground every change in the repository — NEVER fabricate. When a claim can be neither confirmed nor refuted and remains plausibly useful, keep it unchanged.
6. Keep each surviving file's YAML frontmatter `description` accurate (comma-separated retrieval tags).

When every file has been verified, corrections applied, and conflicts resolved, end your turn. Do not modify, create, or delete anything outside `.omp/knowledge`.
