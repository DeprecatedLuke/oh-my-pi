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
3. Call `issues` with `op: add` for each finding (persisted under `.omp/issues/`)
4. Call `yield` with verdict when done

### Custom Instructions

{{instructions}}
