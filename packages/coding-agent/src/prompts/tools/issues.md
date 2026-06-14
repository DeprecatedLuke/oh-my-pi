Project-local issue tracker. Persists findings to `.omp/issues/<category>/<id>-<slug>.md` so they survive across sessions and can be triaged, edited, and archived over time. The global id is auto-allocated; the on-disk slug is derived from the title.

<instruction>
The `issues` tool creates and lifecycles issues; **editing an existing issue (body or metadata) is done by rewriting its `issues://<id>.md` file with the `write` tool**, not through this tool. Pick the op via `op`:
- `add` — Create a new issue. Required: `category`, `title`, `body`. Optional: `severity` (`low|medium|high|critical`), `status` (`open|in-progress|fixed|wontfix|duplicate`; default `open`), `location[]` (paths or `path:line` refs), `extra` (free-form frontmatter merged into the file).
- `archive` — Move an active issue to `.omp/issues/archive/<category>/`. Required: `id`. Optional: `reason` (recorded in frontmatter), `status` (default `fixed`). A shortcut for setting a terminal status that also records a `reason`.
- `unarchive` — Move an archived issue back to active. Required: `id`. Optional: `status` (default `open`). A shortcut for reopening (setting a non-terminal status).
- `list` — Return a summary listing. All params optional: `category`, `archived` (`true`/`false`; default both), `severity`, `status`, `query` (substring search across title/body/frontmatter), `limit`.

**To edit an existing issue, rewrite the whole `issues://<id>.md` file with the `write` tool** — read it first, change what you need, then write the full file back to the `issues://<id>.md` URL (e.g. `issues://14.md`). Always target the id-only `issues://` URL, **not** the on-disk path the read header shows — only the URL write is validated and lifecycle-aware. The frontmatter *is* the metadata layer: changing `title` re-derives the slug, changing `category` moves the file, and setting `status` to `fixed`/`wontfix`/`duplicate` archives it (back to `open`/`in-progress` restores it). The write is rejected if the frontmatter is malformed — a dropped `---` fence, unparseable YAML, or an out-of-enum `status`/`severity`. Read with `issues://<id>.md`; browse with `issues://` (active) and `issues://archive` (archived).
</instruction>

<output>
- `add` returns the new issue's id, category, filename, and full `issues://` URL.
- `archive`/`unarchive` return the new location.
- Writing `issues://<id>.md` with the `write` tool reports any lifecycle effect (moved/renamed/archived) plus the resulting URL.
- `list` returns a markdown summary identical to the `issues://` listing.
</output>

<conventions>
- Categories are kebab-case (`security`, `network-isolation`, `data-correctness`). The reserved name `archive` is rejected.
- Titles are short imperative phrases (~5-10 words); the slug is derived from the first 5 alphanumeric words.
- Bodies are markdown. Recommended sections: a short description paragraph, then a `## Fix` or `## Recommendation` numbered list.
- Use `archive` once the underlying defect is verified fixed (or won't-fix). Leave `status: in-progress` for items being actively worked on this session — an in-progress issue triggers an end-of-turn reminder, so move it to a terminal status (fixed/archived) when done or back to `open` when you set it down.
- To close an issue, set its `status` to a terminal value (`fixed`/`wontfix`/`duplicate`) and write `issues://<id>.md` with the `write` tool, or use `op: archive` (which also records a `reason`). To reopen, set `status: open`/`in-progress` and write the file, or use `op: unarchive`.
</conventions>
