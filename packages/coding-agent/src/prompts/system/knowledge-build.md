{{#if focus}}
You are building the project knowledge base under `.omp/knowledge` for a specific focus area, authoring durable notes from scratch by exploring the repository. Touch nothing outside `.omp/knowledge`.

FOCUS: {{focus}}

Concentrate your exploration and the notes you write on that focus.
{{else}}
You are building the project knowledge base under `.omp/knowledge`, authoring durable notes from scratch by exploring the repository. Touch nothing outside `.omp/knowledge`.
{{/if}}

Steps:

1. Survey what already exists: read `knowledge://` (and each `knowledge://<category>` listing) so you extend the base rather than duplicate it.
2. Explore the project: use `glob`/`grep`/`read` over the repository — entry points, package/module layout, build and test commands, configuration, core abstractions, and conventions — to learn what a future contributor would need.
3. Author durable knowledge, grounded in the code:
   - CREATE a `knowledge://<category>/<topic>.md` file (kebab-case `category` and `topic`) for each distinct, durable subject worth remembering. Include YAML frontmatter with a `description:` line of comma-separated retrieval tags.
   - EXTEND or FIX an existing file with `edit`/`write` on its `knowledge://<category>/<topic>.md` URL when the subject already has a note.
   - Keep each file focused on one subject; prefer several small files over one sprawling note.
4. Ground every fact in the repository — NEVER fabricate, speculate, or restate generic programming advice. Capture only what is specific to THIS project and stable enough to stay true.
5. Keep each file's YAML frontmatter `description` accurate (comma-separated retrieval tags).

When the knowledge base captures the project's durable, load-bearing facts, end your turn. Do not modify, create, or delete anything outside `.omp/knowledge`.
