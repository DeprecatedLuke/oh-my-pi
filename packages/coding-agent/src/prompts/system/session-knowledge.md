<task>Update the project-local agent knowledge base from the preceding session, right now, using your tools.</task>

<knowledge-base>
Root: .omp/knowledge, addressed through `knowledge://` URLs.
File shape: `knowledge://<category>/<topic>.md` with YAML frontmatter `description` holding comma-separated retrieval tags.
Purpose: durable, reusable facts learned this session that should help future sessions — project-specific workflows, IPs/endpoints/hostnames, smoke-test flows, user preferences/frustrations, operational constraints, recurring pitfalls, config keys, and decisions.
</knowledge-base>

<how-to>
1. List what already exists: `read knowledge://`. Read the relevant files: `read knowledge://<category>/<topic>.md`.
2. Fold each durable fact into the knowledge base:
   - Prefer updating an existing file in place: `edit knowledge://<category>/<topic>.md`. Reuse the closest existing category/topic rather than minting a near-duplicate.
   - Only when the topic is genuinely new: `write knowledge://<category>/<topic>.md` with the full markdown document.
3. When every durable fact is captured (or there is nothing durable to save), end your turn. Do not call any more tools.
</how-to>

<rules>
- Treat the preceding conversation as the source material. Do not ask questions.
- Read before you write. If a fact is already recorded, leave it unchanged.
- Preserve useful existing content when editing — merge, do not clobber.
- Do NOT store transient state: task progress, todo lists, one-off command output, or facts only useful for the current handoff.
- Keep files concise and maintainable, like AGENTS.md but agent-maintained.
- Every file MUST start with YAML frontmatter containing `description: <tags>`. The description is shown in the prompt-time Knowledge index and MUST be tag-based: dense comma-separated retrieval tags or short trigger phrases, not a sentence. Favor subsystem names, commands, file names, failure names, user-preference labels, URLs/hostnames, config keys, and workflow names future agents may search for.
- Paths MUST be exactly `<category>/<topic>.md` under `.omp/knowledge`.
- Touch nothing outside the knowledge base.
</rules>

<example>
A new topic written with `write knowledge://build/session-exports.md`:
---
description: build-knowledge, session exports, .omp/knowledge, cache invalidation
---

# Session knowledge exports

- Durable fact…
</example>

<session-source>
<title>{{sourceTitle}}</title>
The preceding conversation is the source material for this knowledge update.
</session-source>
