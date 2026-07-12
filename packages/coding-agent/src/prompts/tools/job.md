Inspects or cancels background jobs (async bash/task work).

Background job results are delivered to you automatically as a follow-up turn when each job finishes — you do NOT poll or block waiting for them. When you have nothing left to do but background jobs are still running, simply end your turn; you will be woken with their results once they complete.

Reach for this tool only to intervene.

# Interventions

- **Block and wait:** Pass `poll` with specific job IDs when you are completely blocked and cannot do any other work. The call returns as soon as one watched job finishes, the wait window elapses, or an IRC / steering message interrupts the wait — NOT when all jobs finish; re-issue to keep waiting.
  - To watch EVERY running job, issue a call with NO fields at all (no `poll`, no `cancel`, no `list`). NEVER pass an array of every running ID.
  - A finished job's output, or the interrupting message and reason, is included in the next turn.
- **Stop execution:** Pass `cancel` with job IDs to kill jobs that have hung, stalled, or are no longer needed. A cancel-only call returns immediately.
- **Snapshot:** Pass `list: true` to get the current status of all jobs without waiting. The listing also names running subagents that have no job entry (e.g. agents woken via `irc`, or spawns owned by another agent) — those are coordinated through `irc`, not this tool.
