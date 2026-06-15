<task>Update the project-local agent knowledge base from the preceding session context.</task>

<knowledge-base>
Root: .omp/knowledge
File shape: .omp/knowledge/<category>/<topic>.md with YAML frontmatter `description` containing comma-separated retrieval tags.
Purpose: durable, reusable facts learned by agents: project-specific workflows, IPs/endpoints, smoke-test flows, user preferences/frustrations, operational constraints, recurring pitfalls, and decisions that should help future sessions.
</knowledge-base>

<rules>
- Treat the preceding conversation as the session material; do not ask follow-up questions or call tools.
- Read existing knowledge before adding anything. If the same knowledge already exists, output no change for it.
- Prefer updating an existing category/topic file when the new fact belongs there. Create a new file only for a genuinely new category/topic.
- Preserve useful existing content when updating a file; return the full desired markdown file content.
- Do not store transient task progress, todo state, one-off command output, or facts only useful for the current handoff.
- Keep files concise and maintainable, like AGENTS.md but agent-maintained rather than user-curated.
- Every returned file MUST start with YAML frontmatter containing `description: <tags>`. Description is shown in the prompt-time Knowledge index and MUST be tag-based: dense comma-separated retrieval tags or short trigger phrases, not a sentence. Prefer subsystem names, commands, file names, failure names, user preference labels, URLs/hostnames, config keys, and workflow names future agents may look for.
- Paths MUST be exactly <category>/<topic>.md, relative to .omp/knowledge.
- Return your result by calling the `save_knowledge` tool exactly once. Pass an empty `files` array when nothing durable should be saved.
</rules>

<save_knowledge-arguments>
Call `save_knowledge` with a `files` array; each entry is `{"path":"category/topic.md","content":"<full markdown file>"}`. Example file content:
---
description: build-knowledge, session exports, .omp/knowledge, cache invalidation
---

# Topic

- Durable fact…
</save_knowledge-arguments>

<existing-knowledge>
{{existingKnowledge}}
</existing-knowledge>

<session-source>
<title>{{sourceTitle}}</title>
The preceding conversation is the source material for this extraction.
</session-source>
