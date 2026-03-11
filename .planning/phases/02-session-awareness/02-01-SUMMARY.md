---
phase: 02-session-awareness
plan: 01
subsystem: session-awareness
tags: [ipc, concurrency, container-lifecycle]
dependency_graph:
  requires: [group-folder, group-queue, config]
  provides: [session-awareness-writer, container-lifecycle-hooks]
  affects: [index]
tech_stack:
  added: []
  patterns: [atomic-file-write, callback-hooks, ipc-coordination]
key_files:
  created:
    - src/session-awareness.ts
    - src/session-awareness.test.ts
  modified:
    - src/group-queue.ts
    - src/index.ts
decisions:
  - "Callbacks on GroupQueue (not direct import) — keeps GroupQueue decoupled from session-awareness"
  - "onContainerStart fires in registerProcess (not runForGroup) — that's when both containerId and groupFolder are known"
  - "onContainerExit fires before containers.delete in finally blocks — slot data still available"
  - "readActiveSessionsFile validates JSON shape, returns empty on corrupt — defensive for container-side readers"
  - "11 tests (not 7 minimum) — added coverage for shape validation, timestamp refresh, directory creation, idempotent remove"
metrics:
  duration: 188s
  completed: 2026-03-11T21:03:22Z
  tasks: 2
  files_created: 2
  files_modified: 2
---

# Phase 02 Plan 01: Session Awareness File Writer Summary

Host-side IPC file writer tracking active containers per group via atomic JSON writes, wired into GroupQueue lifecycle via decoupled callbacks.

## What Was Built

### Session Awareness Module (`src/session-awareness.ts`)

Three exported functions for managing `data/ipc/{groupFolder}/active_sessions.json`:

- **`writeActiveSessionsFile(groupFolder, session)`** — Reads existing file (or starts empty), appends the new session, writes atomically via temp file + rename. Creates IPC directory if needed.
- **`removeActiveSession(groupFolder, containerId)`** — Filters out the matching session, writes back atomically. Leaves `{ sessions: [], updatedAt }` when last session removed (file never deleted).
- **`readActiveSessionsFile(groupFolder)`** — Reads and validates the file. Returns empty structure on missing, corrupt, or malformed files.

File format:
```json
{
  "sessions": [
    { "containerId": "...", "started": "2026-03-11T21:00:00Z", "type": "message", "repos": [] }
  ],
  "updatedAt": "2026-03-11T21:00:00Z"
}
```

### GroupQueue Lifecycle Hooks (`src/group-queue.ts`)

Two optional callback hooks added to GroupQueue, wired via setter methods (same pattern as `setProcessMessagesFn`):

- **`setOnContainerStart(fn)`** — Called in `registerProcess()` when both `containerId` and `groupFolder` are known.
- **`setOnContainerExit(fn)`** — Called in the `finally` blocks of both `runForGroup()` and `runTask()`, before `containers.delete()`.

Both callbacks are null by default — existing tests are completely unaffected (no new dependencies, no mocking required).

### Wiring (`src/index.ts`)

Module-level wiring after `const queue = new GroupQueue()`:
- `queue.setOnContainerStart` → calls `writeActiveSessionsFile`
- `queue.setOnContainerExit` → calls `removeActiveSession`

## Test Coverage

11 tests in `src/session-awareness.test.ts`:

1. Writes session file on first container
2. Appends second session with different containerId
3. Removes session on exit, leaving the other
4. Removes last session leaving empty sessions array (file persists)
5. Handles missing file gracefully
6. Handles corrupt file gracefully
7. Uses atomic write pattern (temp file + rename verified via spy)
8. Handles file with invalid shape (missing sessions array)
9. Updates updatedAt timestamp on each write
10. Creates IPC directory if it does not exist
11. removeActiveSession is safe for non-existent containerId

Full suite: 382 tests pass (371 existing + 11 new), zero regressions.

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | `65616fa` | feat(02-01): add session-awareness module with lifecycle file writer |
| 2 | `e2276a1` | feat(02-01): wire session awareness into GroupQueue lifecycle hooks |

## Self-Check: PASSED

- [x] `src/session-awareness.ts` — FOUND (5 exports: 3 functions + 2 interfaces)
- [x] `src/session-awareness.test.ts` — FOUND (11 tests)
- [x] `02-01-SUMMARY.md` — FOUND
- [x] Commit `65616fa` — FOUND
- [x] Commit `e2276a1` — FOUND
- [x] Build: clean (no type errors)
- [x] Tests: 382/382 passing (371 existing + 11 new)
