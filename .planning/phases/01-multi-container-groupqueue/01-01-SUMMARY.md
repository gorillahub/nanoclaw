---
phase: 01-multi-container-groupqueue
plan: 01
subsystem: group-queue
tags: [concurrency, data-model, refactor]
dependency_graph:
  requires: []
  provides: [multi-container-groupqueue, container-slot-model]
  affects: [index.ts, task-scheduler.ts, group-queue.test.ts]
tech_stack:
  added: []
  patterns: [container-slot-map, pending-registration-bridge, idle-container-reuse]
key_files:
  created: []
  modified: [src/group-queue.ts]
decisions:
  - ContainerSlot map replaces active boolean for multi-container support
  - pendingRegistrations map bridges containerId from runForGroup to registerProcess
  - containerId parameter made optional on public API for backward compatibility
  - Idle container reuse checked before global cap (no new slot cost)
metrics:
  duration: 308s
  completed: 2026-03-11T20:44:45Z
---

# Phase 01 Plan 01: Refactor GroupQueue Data Model Summary

Multi-container GroupQueue using ContainerSlot map per group, replacing single-container `active: boolean` bottleneck with concurrent container support capped by global `MAX_CONCURRENT_CONTAINERS`.

## What Changed

### Data Model

The `GroupState` interface was fundamentally restructured:

**Before:** Single-container model with `active: boolean`, one `process`, one `containerName`, one `groupFolder` per group. Only one container could run per group at any time.

**After:** Multi-container model with `containers: Map<string, ContainerSlot>`. Each group can have multiple concurrent containers, each with independent lifecycle state (idleWaiting, process, containerName, groupFolder, runningTaskId).

### New Internal Type: ContainerSlot

```typescript
interface ContainerSlot {
  containerId: string;       // unique per slot, generated at spawn time
  type: 'message' | 'task';
  idleWaiting: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  runningTaskId: string | null;
}
```

### Method Changes

| Method | Change |
|--------|--------|
| `getGroup()` | Initialises with `containers: new Map()` instead of `active: boolean` |
| `enqueueMessageCheck()` | Checks for idle container reuse first, then spawns new if under cap |
| `enqueueTask()` | Dedup scans all container slots; preempts idle containers |
| `registerProcess()` | Accepts optional `containerId`; uses `pendingRegistrations` bridge |
| `notifyIdle()` | Accepts optional `containerId`; targets specific slot |
| `sendMessage()` | Finds any idle non-task container internally |
| `closeStdin()` | Accepts optional `containerId`; can target specific or first idle |
| `runForGroup()` | Creates ContainerSlot, manages slot lifecycle in finally block |
| `runTask()` | Creates task ContainerSlot, manages slot lifecycle in finally block |
| `drainGroup()` | Checks global cap before starting new containers |
| `shutdown()` | Iterates all groups' containers maps for detached container count |
| `setProcessMessagesFn()` | Callback signature now includes `containerId` parameter |

### Key Design: pendingRegistrations Bridge

The `containerId` flows from `runForGroup`/`runTask` (which generates it) to `registerProcess` (called by external code) via a `pendingRegistrations` map. This is safe because Node.js is single-threaded — `registerProcess` is called synchronously within the `processMessagesFn` callback chain.

### Backward Compatibility

All public methods that now accept `containerId` make it optional. Existing callers (`index.ts`, `task-scheduler.ts`) continue to work without changes. Plan 01-02 will update callers to pass `containerId` explicitly.

## Edge Cases Verified

1. **Race condition** — Two rapid `enqueueMessageCheck` calls: slot created synchronously with `idleWaiting=false`, second call won't mistake new slot for idle
2. **Global cap mid-group** — Idle reuse checked before cap (doesn't cost a slot)
3. **Container cleanup on error** — `finally` blocks always delete slot and decrement `activeCount`
4. **Multiple idle containers** — `sendMessage` picks first, others time out naturally
5. **Task dedup across containers** — `enqueueTask` scans all slots' `runningTaskId`
6. **Drain with multiple containers** — Only starts new work when under cap; doesn't touch running containers

## Verification

- `npx tsc --noEmit` — **0 errors** (full project compiles, not just group-queue.ts)
- `npm run build` — **passes cleanly**
- `npx vitest run` — **1 expected test failure** in `group-queue.test.ts`: the test "only runs one container per group at a time" now correctly fails because we've removed that constraint. Plan 01-03 updates the tests.
- **366/367 tests pass** (all except the one enforcing old single-container behaviour)

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Replace GroupState single-container model with ContainerSlot map | `62fc74d` | src/group-queue.ts |
| 2 | Verify GroupQueue internal consistency and edge cases | `b7f36f2` | src/group-queue.ts |

## Self-Check: PASSED

All files exist, all commits verified, all key patterns present in source.
