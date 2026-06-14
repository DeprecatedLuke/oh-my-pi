Project-local issue tracker. Persists findings to `.omp/issues/<category>/<id>-<slug>.md` so they survive across sessions and can be triaged, edited, and archived over time. The global id is auto-allocated; the on-disk slug is derived from the title.

<instruction>
Pick the op via `op`. Each op uses a subset of the parameters:
- `add` — Create a new issue. Required: `category`, `title`, `body`. Optional: `severity` (`low|medium|high|critical`), `status` (`open|in-progress|fixed|wontfix|duplicate`; default `open`), `location[]` (paths or `path:line` refs), `extra` (free-form frontmatter merged into the file).
- `edit` — Update an existing issue's metadata. Required: `id`. Optional: `title`, `category`, `severity`, `status`, `location[]`, `extra`. **Body edits do not go through this op** — edit the markdown body with the `edit` tool on `issues://<id>.md`. Changing `status` to `fixed`/`wontfix`/`duplicate` auto-archives an active issue; changing it back to `open`/`in-progress` auto-restores it. Re-titling renames the file slug; changing category moves the file between category dirs.
- `archive` — Move an active issue to `.omp/issues/archive/<category>/`. Required: `id`. Optional: `reason` (recorded in frontmatter), `status` (default `fixed`). Equivalent to `edit` with a terminal status, but supports an explicit `reason`.
- `unarchive` — Move an archived issue back to active. Required: `id`. Optional: `status` (default `open`). Equivalent to `edit` with an open status.
- `list` — Return a summary listing. All params optional: `category`, `archived` (`true`/`false`; default both), `severity`, `status`, `query` (substring search across title/body/frontmatter), `limit`.

Read individual issues via the `issues://<filename>.md` URL (e.g. `issues://14-fix-egress.md` or `issues://14.md`). Browse with `issues://` (active) and `issues://archive` (archived). **To rewrite an issue's body, use the `edit` tool on the same URL** — `issues://<id>.md` is writable; the `issues` tool owns metadata and lifecycle, not body content.
</instruction>

<output>
- `add` returns the new issue's id, category, filename, and full `issues://` URL.
- `edit` returns the updated id and flags for `moved` (category change), `renamed` (slug change), `transitioned` (active↔archive via status).
- `archive`/`unarchive` return the new location.
- `list` returns a markdown summary identical to the `issues://` listing.
</output>

<conventions>
- Categories are kebab-case (`security`, `network-isolation`, `data-correctness`). The reserved name `archive` is rejected.
- Titles are short imperative phrases (~5-10 words); the slug is derived from the first 5 alphanumeric words.
- Bodies are markdown. Recommended sections: a short description paragraph, then a `## Fix` or `## Recommendation` numbered list.
- Use `archive` once the underlying defect is verified fixed (or won't-fix). Leave `status: in-progress` for items being actively worked on this session — an in-progress issue triggers an end-of-turn reminder, so move it to a terminal status (fixed/archived) when done or back to `open` when you set it down.
- Use `edit` (or `archive`) to close an issue. Use `edit` with `status: open|in-progress` (or `unarchive`) to bring an archived one back.
</conventions>
