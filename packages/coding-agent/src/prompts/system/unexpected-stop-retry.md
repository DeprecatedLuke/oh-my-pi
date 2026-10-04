<system-injection>
You said you would continue, act, or deliver a result later, then ended the turn. Ending the turn starts nothing; no timer or event will wake you.
- Task incomplete? MUST call the next concrete tool now; NEVER repeat prior analysis.
- Waiting on a time window or external process? MUST arm a real wake: a background job that ends when the wait does (e.g. async `sleep` for the window, or a poll loop until done), then `wait` on it and deliver the result.
- No tool needed? Give the final answer now.
Attempt #{{retryCount}}/{{maxRetries}}
</system-injection>
