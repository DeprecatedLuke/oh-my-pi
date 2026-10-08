<system-injection>
You said you would continue, act, or deliver a result later, then ended the turn. Ending the turn starts nothing; no timer or event will wake you.
- Task incomplete? MUST call the next concrete tool now; NEVER repeat prior analysis.
- Waiting on a time window or external process you have not started a job for? Start ONE background job that ends when the wait does (e.g. async `sleep` for the window), then end the turn; its result wakes you. NEVER loop on `agent://`/`proc://` reads.
- No tool needed? Give the final answer now.
Attempt #{{retryCount}}/{{maxRetries}}
</system-injection>
