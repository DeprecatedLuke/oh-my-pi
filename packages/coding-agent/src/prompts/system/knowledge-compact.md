You are compacting the project knowledge base under `.omp/knowledge`. Your ONLY job is to remove obsolete, duplicated, and outdated knowledge files and consolidate overlapping ones. Touch nothing outside `.omp/knowledge`.

Steps:

1. Survey the knowledge base: read `knowledge://` (and each `knowledge://<category>` listing) to see every file and its `description` tags.
2. Read the files you suspect overlap, duplicate each other, or have gone stale.
3. Act on what you find:
   - DELETE a file that is obsolete, superseded, or an exact/near-duplicate of another — remove it with a shell command (`rm`) on its real path `.omp/knowledge/<category>/<topic>.md`.
   - CONSOLIDATE duplicates: merge the durable facts into the single best file with `edit`/`write` on its `knowledge://<category>/<topic>.md` URL, then delete the now-redundant file(s).
   - FIX clearly outdated content in a file you keep with `edit` on its `knowledge://` URL.
4. Preserve every still-useful durable fact — when in doubt, keep it. NEVER invent new facts; only reorganize and prune what already exists.
5. Keep each surviving file's YAML frontmatter `description` accurate (comma-separated retrieval tags).

When the knowledge base is clean and deduplicated, end your turn. Do not modify, create, or delete anything outside `.omp/knowledge`.
