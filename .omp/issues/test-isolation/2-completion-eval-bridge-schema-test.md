---
title: completion() eval bridge schema test fails only under cumulative full-suite load
category: test-isolation
severity: low
status: open
created: '2026-06-17T02:27:07.449Z'
updated: '2026-06-17T02:27:07.449Z'
location:
  - 'packages/coding-agent/src/eval/__tests__/completion-bridge.test.ts:382-387'
  - 'packages/coding-agent/src/eval/js/shared/runtime.ts:214-248'
  - 'packages/coding-agent/src/eval/completion-bridge.ts:133-170'
---

## Problem

`src/eval/__tests__/completion-bridge.test.ts` › "completion() through eval runtimes > parses structured completion() output in the JavaScript runtime" fails in the full `bun test` run (`expect(result.exitCode).toBe(0)` → got 1; bun frames it as "Unhandled error between tests"). The cell `completion("hi", { schema: { type: "object" } })` throws. The non-schema `completion()` test passes — only the structured/`toolChoice` path fails.

## Not a single polluter — cumulative threshold (bisected)

Binary search over the ordered `test/` file list (bun runs passed files in one shared process in discovery order, victim appended last) showed it is NOT a discrete leaked mock:
- full suite (771 files) → fails; `test/` + `src/eval/__tests__/` (768) → fails.
- first 379 `test/` files + victim → victim PASSES.
- second 380 `test/` files + victim → victim FAILS.
- but every sub-segment of that failing half PASSES: h2bb (95) pass, c2 (48) pass, d2 (24) pass, e2 (12) pass, and both 6-file leaves pass.
- So the threshold sits between ~95 and ~380 preceding files. No single file (or small batch) reproduces; it needs a critical mass.

This is a cumulative/timing effect (most likely an abandoned-eval-run's unhandled rejection landing on whichever test runs when it fires, which by suite size lands here; or resource accumulation across ~hundreds of runtimes). Same CLASS as the suite's other order-dependent pollution (`executeJs > persists bindings`, and baseline's `AsyncJobManager singleton` / `rewriteImports`, which shift run-to-run). It passes in isolation and in the whole `test/eval` + `src/eval/__tests__` batch (71 pass).

## Context / not a merge regression in aggregate

Surfaced during the 2026-06-16 upstream merge (upstream added the same-realm run-owner guard in `src/eval/js/shared/runtime.ts`). The merge's same-realm CASCADE (22 failures) was fixed by `JsRuntime.dispose()` force-releasing `activeGlobalRunOwner`/`activeGlobalRunDepth` (see CHANGELOG). After that fix the full suite is 8 fail vs the pre-merge baseline's 9 — so net suite health did not regress; this is the one residual.

## Fix (when picked up)

Root is an abandoned JS eval run whose promise never settles and later rejects unhandled (the dispose fix released the realm owner but not the dangling rejection). Options:
1. Make abandoned runs reject in a HANDLED way: when `JsRuntime.dispose()` runs with an in-flight run, settle/swallow the run promise (or have the EvalTool/context-manager attach a `.catch` to a run it abandons on timeout/cancel) so no unhandled rejection escapes to a later test boundary.
2. Find the test that starts an eval run it never awaits / that is killed by timeout (candidates: `test/tools/eval-timeout.test.ts` and any `agent()`/`parallel()` rejection test) and make it await/dispose deterministically.
Validate by full-suite count (not isolation): the victim must stop failing with ≥380 preceding files.
