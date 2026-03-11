---
phase: 01-multi-container-groupqueue
plan: 03
subsystem: group-queue
tags: [testing, tdd, multi-container, concurrency]
dependency_graph:
  requires: [multi-container-groupqueue, container-slot-model]
  provides: [multi-container-test-suite]
  affects: []
tech_stack:
  added: []
  patterns: [concurrent-container-testing, containerId-mock-extraction, completion-callback-control]
key_files:
  created: []
  modified: [src/group-queue.test.ts]
decisions:
  - Extract containerId from processMessagesFn mock calls for precise slot targeting in tests
  - Use completion callback arrays indexed by invocation order for concurrent container control
  - Backward compat test (COMPAT-01) validates single message produces one processMessagesFn call with containerId
metrics:
  duration: 128s
  completed: 2026-03-11T20:49:00Z
---

# Phase 01 Plan 03: Multi-Container GroupQueue Test Suite Summary

17-test suite validating concurrent container semantics: same-group concurrency (CONC-01), idle reuse (CONC-05), global cap enforcement (CONC-04), backward compat (COMPAT-01), plus all existing concepts (retry, shutdown, drain, dedup, preemption).

## What Changed

### Test Suite Rewrite

The existing 13 tests enforced single-container-per-group semantics. The rewritten suite (17 tests) validates multi-container behaviour while preserving the same underlying intent for retry, shutdown, drain, dedup, and preemption.

**Before:** 13 tests, 1 failing (`only runs one container per group at a time` — expected failure post Plan 01-01). All `processMessagesFn` mocks took `(groupJid: string)` only. `registerProcess`/`notifyIdle` called without `containerId`.

**After:** 17 tests, all passing. All mocks updated to `(groupJid: string, containerId: string)`. Tests extract `containerId` from mock calls for precise slot targeting. Full test suite passes at 371/371.

### Updated Existing Tests (12 tests)

| # | Test | Change |
|---|------|--------|
| 1 | Global concurrency limit | Updated mock signature, same assertion logic |
| 2 | Tasks prioritised over messages in drain | Updated mock signature |
| 3 | Retry with exponential backoff | Updated mock signature |
| 4 | Shutdown prevents new enqueues | Updated mock signature |
| 5 | Max retries exceeded | Updated mock signature |
| 6 | Waiting groups drained | Updated mock signature |
| 7 | Running task dedup | Same (task fn unchanged) |
| 8 | Active container NOT preempted | Added containerId extraction + explicit registerProcess |
| 9 | Idle container preempted | Added containerId extraction + explicit registerProcess/notifyIdle |
| 10 | sendMessage resets idleWaiting | Added containerId extraction + explicit registerProcess/notifyIdle |
| 11 | sendMessage returns false for task containers | Uses pending registration bridge (no containerId) |
| 12 | Idle notification with pending tasks | Added containerId extraction + explicit registerProcess/notifyIdle |

### New Multi-Container Tests (5 tests)

| # | ID | Test | Validates |
|---|----|------|-----------|
| 13 | CONC-01 | Concurrent containers for same group | Two enqueueMessageCheck calls → two concurrent processMessagesFn invocations with different containerIds |
| 14 | CONC-04 | Global cap across same-group containers | Group fills both slots → third queues → freed slot starts third |
| 15 | CONC-05 | Idle container reuse | Idle container exists → new enqueueMessageCheck sets pendingMessages, doesn't spawn |
| 16 | COMPAT-01 | Single message identical behaviour | One message → one processMessagesFn call with groupJid + containerId |
| 17 | — | Multi-group mixed concurrency | Two groups each get a container, both run concurrently under cap |

### Testing Patterns

**containerId extraction:** Tests extract `containerId` from `processMessages.mock.calls[0][1]` after the first `advanceTimersByTimeAsync`, then pass it to `registerProcess` and `notifyIdle` for precise slot targeting.

**Completion callback control:** Concurrent container tests use `Array<() => void>` completion callbacks. Each `processMessagesFn` invocation pushes a resolve function, giving tests precise control over when each container "finishes".

**No source modifications:** Only `src/group-queue.test.ts` was modified. The GroupQueue source (`src/group-queue.ts`) was not touched — tests validate the Plan 01-01 refactored implementation as-is.

## Verification

- `npx vitest run src/group-queue.test.ts` — **17/17 tests pass**
- `npx vitest run` — **371/371 tests pass** (was 366/367 before, +4 net new tests, +1 fixed failure)
- No regressions in any other test file

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Rewrite and extend GroupQueue test suite for multi-container semantics | `cbc3623` | src/group-queue.test.ts |

## Self-Check: PASSED
