Inspect or checkpoint Git repositories without shelling out.

<parameters>
- `op`: `"status" | "checkpoint"`
- `reason`: optional short reason for `checkpoint`
</parameters>

<behavior>
- `status` reports every detected repository under the current workspace, including unlinked nested Git repos.
- `checkpoint` (also exposed as `git checkpoint` in slash-command prose) stages dirty files in each detected repository, creates local WIP commits, and leaves clean repos untouched.
- Checkpoints are local only. They are not pushes, releases, or deploys.
- Subagents cannot use this tool. Main session owns Git state.
</behavior>

<examples>
# Inspect current Git state
`git {"op":"status"}`

# Save a scope boundary
`git {"op":"checkpoint","reason":"after task integration"}`
</examples>

<critical>
- You SHOULD call `git` with `op: "checkpoint"`, not Bash `git commit`.
- You SHOULD checkpoint at scope boundaries, not after every edit.
- You NEVER use this tool to publish work.
</critical>
