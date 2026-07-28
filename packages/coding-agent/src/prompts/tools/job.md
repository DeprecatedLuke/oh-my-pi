Inspects or cancels background jobs (async bash/task work).

Background job results are delivered automatically as a follow-up turn when each job finishes. When no independent work remains, end the turn immediately — produce NO prose, status, filler, or progress tokens, invoke NO wait/sleep/poll/status/unrelated tool call. Results arrive automatically after completion.
Reach for this tool only to intervene.

## `list: true`
Snapshot every background job (running and recently finished) for inspection. Read-only; returns immediately.

## `cancel: [id, …]`
Stop running jobs — use when a job is stalled, hung, or no longer needed. Returns immediately after cancelling.
