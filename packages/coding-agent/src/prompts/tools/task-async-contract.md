Results arrive automatically as a follow-up turn. NEVER poll, sleep, or loop on `proc://`/`agent://` reads (shell or eval).{{#if waitTool}} Completely blocked? Call `wait` to receive the first settled job you started.{{else}} Nothing else to do? End the turn now.{{/if}}
{{#if ircEnabled}}Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast).{{/if}}

`read proc://` lists jobs/services; `read proc://<id>` / `read agent://<id>` are one-off checks that never consume delivery. `write proc://<id>/kill` cancels/stops; omit `content`.

A delivered result is already in your context; its `proc://` row drops ~30s later, other finished rows after ~5min. Job IDs are process-local. Agent output/transcripts stay readable at `agent://<id>` / `history://<id>`.{{#if ircEnabled}} `write agent://<id>` messages a live agent.{{/if}}

`completed`: subagent yielded successfully; claimed artifacts unverified.
