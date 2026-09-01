<task>Update the project-local agent knowledge base from the preceding session, right now, using your tools.</task>

<knowledge-base>
Root: .omp/knowledge, addressed through `knowledge://` URLs.
File shape: `knowledge://<category>/<topic>.md` with YAML frontmatter `description` holding comma-separated retrieval tags.
Purpose: durable, reusable facts learned this session that should help future sessions — project-specific workflows, IPs/endpoints/hostnames, smoke-test flows, user preferences/frustrations, operational constraints, recurring pitfalls, config keys, and decisions.
</knowledge-base>

<how-to>
1. You MUST triage the conversation first. Identify durable deltas: facts learned this session that existing notes do not already imply. None? End immediately; call no tools.
2. List the index: `read knowledge://`. Select ONLY the closest files by their descriptions. Read only those files: `read knowledge://<category>/<topic>.md`.
3. You SHOULD verify only uncertain, load-bearing claims (paths, symbols, commands, config keys). Confident conversation facts need no verification.
4. Record each durable delta:
   - Update the closest existing file: `edit knowledge://<category>/<topic>.md`. Merge; NEVER duplicate. Already recorded? Leave unchanged.
   - Genuinely new topic? `write knowledge://<category>/<topic>.md` with the full document.
5. Every delta captured? End immediately; call no more tools.
</how-to>

<rules>
- Treat the preceding conversation as source material. NEVER ask questions.
- You MUST read a selected file before editing it.
- NEVER scan or reconcile unrelated notes. This is a focused session distill, not full-base verification.
- NEVER store transient state: task progress, todo lists, one-off output, or facts useful only for this handoff.
- Keep files concise and maintainable, like AGENTS.md but agent-maintained.
- Every file MUST start with YAML frontmatter containing `description: <tags>`. The description is shown in the prompt-time Knowledge index and MUST be tag-based: dense comma-separated retrieval tags or short trigger phrases, not a sentence. Favor subsystem names, commands, file names, failure names, user-preference labels, URLs/hostnames, config keys, and workflow names future agents may search for.
- Paths MUST be exactly `<category>/<topic>.md` under `.omp/knowledge`.
- NEVER touch paths outside the knowledge base.
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
