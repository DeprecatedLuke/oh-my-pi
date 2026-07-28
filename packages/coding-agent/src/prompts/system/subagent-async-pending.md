Your yield was recorded, but {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after these jobs settle AND you submit a fresh `yield` that accounts for their results. Job results arrive as follow-up messages; a result that arrives after your yield supersedes it — your current yield will NOT be accepted as the final report.

Real independent work remains? Continue it, preferring useful overlap with running jobs. Once exhausted — or if none remains — end this turn immediately; produce NO prose, status, filler, or progress tokens, invoke NO wait/sleep/poll/status/unrelated tool call. Results auto-deliver; re-submit a fresh `yield` incorporating them when they arrive.

Job no longer needed? Cancel it with `hub cancel` and re-yield. Cancellation is only for stalled, abandoned, or unneeded work; it cannot carry a message.
