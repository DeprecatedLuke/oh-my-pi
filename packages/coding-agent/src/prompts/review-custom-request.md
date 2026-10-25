## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

Use the `task` tool with a `tasks` array. Set `agent: "reviewer"` inside the `tasks[]` item (`tasks[].agent`), never at the top level or omitted.
Create exactly **1 reviewer task**. Its assignment MUST include the custom instructions below.

### Reviewer Instructions

Reviewer MUST:
1. Follow the custom instructions below
2. Read the referenced files or workspace context needed to evaluate them
3. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool

### Custom Instructions

{{instructions}}
