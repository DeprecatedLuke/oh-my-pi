---
title: 'Tests creating real SessionManager/AgentSession leak breadcrumbs into the dev''s ~/.omp'
category: test-isolation
severity: medium
status: open
created: '2026-06-16T23:03:11.669Z'
updated: '2026-06-16T23:03:11.669Z'
location:
  - 'packages/coding-agent/test/agent-session-handoff.test.ts:77-79'
  - 'packages/coding-agent/src/session/session-manager.ts:366-367'
  - 'packages/utils/src/dirs.ts:723'
  - bunfig.toml
---

## Problem

Tests that construct a real `SessionManager`/`AgentSession` without isolating the **agent dir** write terminal breadcrumbs into the developer's real `~/.omp/agent/terminal-sessions/<terminalId>`. `getTerminalSessionsDir()` resolves under the live `dirs` resolver (agent dir), and `SessionManager.create`/`open`/`#resetToNewSession` call `#rememberBreadcrumb` → `writeTerminalBreadcrumb(cwd, sessionFile)` using the inherited real `TMUX_PANE`/pts terminal id.

Proven leaker: `test/agent-session-handoff.test.ts` (`beforeEach`: `tempDir = TempDir.createSync("@pi-handoff-")`, `SessionManager.create(tempDir, tempDir)` — no `setAgentDir`). Running the full coding-agent suite in an interactive terminal poisoned that terminal's real breadcrumb with `/tmp/pi-handoff-*/<session>.jsonl`. If the dev runs `omp --continue` in that terminal before the temp dir is cleaned, they resume the test's temp session.

Scope: ~66 of ~93 test files that create real sessions do NOT fake `TMUX_PANE` or `setAgentDir` (only 27 isolate, e.g. `continue-relocation.test.ts`, `continue-skip-subagent.test.ts`). Most use `TempDir` for the session dir, so the breadcrumb self-heals once the temp dir is deleted (the breadcrumb's target no longer exists → `readTerminalBreadcrumbEntry` returns null → fallthrough), making impact low and intermittent — but it still clobbers the dev's real breadcrumb on every suite run.

Note: this is distinct from the production subagent-resume bug (fixed via path-based `isSubagentSessionFile` detection). Production handoffs are normal resumable sessions and must NOT be skipped — only the test puts them in /tmp.

## Fix

Recommended: a global test preload that isolates the agent dir for the whole test process.
1. Add `test/setup/isolate-agent-dir.ts` that, on import, `setAgentDir(fs.mkdtempSync(...))`. `getTerminalSessionsDir`/`getAgentDir`/`getSessionsDir` read the live `dirs` resolver, so a preload `setAgentDir` redirects them (verified: no import-time memoization in `packages/utils/src/dirs.ts`). Tests that further `setAgentDir(theirTemp)` + restore still work (they capture the preload temp as "original").
2. Wire via root `bunfig.toml` `[test] preload = [...]` (a package-level bunfig would lose the root `[loader]`/`[install]` config since bun does not merge bunfigs).
3. Validate: run the FULL multi-package suite — flipping the default agent dir for ~66 tests may trip any that read real `~/.omp` config or assert a hardcoded default path. Two existing assertions (`discovery/pi-config-dir.test.ts`, `session-manager/file-operations.test.ts`) compare against `getAgentDir()`/`getSessionsDir()` so are robust; audit for others.

Alternative (narrower, incomplete): isolate per-test in the leakers (the `continue-relocation.test.ts` pattern: fake `TMUX_PANE` + `setAgentDir(temp)` + restore in `afterEach`). Whack-a-mole across ~66 files; the preload is preferred.
