# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** Phase 1 — Multi-Container GroupQueue (Plans 01 + 03 complete)
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 1 — Multi-Container GroupQueue
- **Plan:** 3 of 3
- **Status:** In Progress
- **Progress:** ███░░░░░░░ 33%

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 2 |
| Phases complete | 0 |
| Plans total | 6 |
| Plans complete | 2 |
| Tasks total | 3 |
| Tasks complete | 3 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 308s | 2 | 1 |
| 01 | 03 | 128s | 1 | 1 |

## Accumulated Context

### Key Decisions
- ContainerSlot map replaces active boolean for multi-container support
- pendingRegistrations map bridges containerId from runForGroup to registerProcess
- containerId parameter made optional on public API for backward compatibility
- Idle container reuse checked before global cap (no new slot cost)
- Extract containerId from processMessagesFn mock calls for precise slot targeting in tests
- Use completion callback arrays for concurrent container control in tests

### Technical Notes
- GroupQueue now uses `containers: Map<string, ContainerSlot>` per group — multi-slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` finds any idle non-task container and pipes to it
- `closeStdin()` can target a specific container via containerId or first idle
- `registerProcess()` uses pendingRegistrations bridge for containerId flow
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`type: 'task'`) reject `sendMessage()` — this stays
- `setProcessMessagesFn` callback now includes `containerId` parameter
- 371/371 tests pass (was 366/367, now all green after test rewrite)
- Test suite covers: CONC-01, CONC-04, CONC-05, COMPAT-01 + all existing concepts

### Blockers
- (none)

### TODOs
- (none)

## Session Continuity

### Last Session
- 2026-03-11T20:49:00Z

### Handover Notes
- Plan 01-01 complete: GroupQueue data model refactored to multi-container
- Plan 01-03 complete: Test suite rewritten for multi-container semantics (17 tests, all passing)
- Next: Plan 01-02 (update callers in index.ts and task-scheduler.ts)
