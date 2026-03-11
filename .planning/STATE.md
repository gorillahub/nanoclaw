# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** Phase 1 — Multi-Container GroupQueue (Plan 01 complete)
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 1 — Multi-Container GroupQueue
- **Plan:** 2 of 3
- **Status:** In Progress
- **Progress:** █░░░░░░░░░ 11%

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 2 |
| Phases complete | 0 |
| Plans total | 6 |
| Plans complete | 1 |
| Tasks total | 2 |
| Tasks complete | 2 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 308s | 2 | 1 |

## Accumulated Context

### Key Decisions
- ContainerSlot map replaces active boolean for multi-container support
- pendingRegistrations map bridges containerId from runForGroup to registerProcess
- containerId parameter made optional on public API for backward compatibility
- Idle container reuse checked before global cap (no new slot cost)

### Technical Notes
- GroupQueue now uses `containers: Map<string, ContainerSlot>` per group — multi-slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` finds any idle non-task container and pipes to it
- `closeStdin()` can target a specific container via containerId or first idle
- `registerProcess()` uses pendingRegistrations bridge for containerId flow
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`type: 'task'`) reject `sendMessage()` — this stays
- Existing test `only runs one container per group at a time` now fails (expected — Plan 01-03 fixes)
- `setProcessMessagesFn` callback now includes `containerId` parameter
- 366/367 tests pass (1 expected failure in old single-container test)

### Blockers
- (none)

### TODOs
- (none)

## Session Continuity

### Last Session
- 2026-03-11T20:44:45Z

### Handover Notes
- Plan 01-01 complete: GroupQueue data model refactored to multi-container
- Next: Plan 01-02 (update callers in index.ts and task-scheduler.ts)
- Then: Plan 01-03 (update tests for multi-container behaviour)
