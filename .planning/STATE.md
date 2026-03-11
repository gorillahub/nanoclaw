# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** Phase 2 — Session Awareness (Plan 01 complete, Plan 02 next)
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 2 — Session Awareness
- **Plan:** 1 of 2 (02-01 complete)
- **Status:** In Progress
- **Progress:** ██████░░░░ 67%

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 2 |
| Phases complete | 0 |
| Plans total | 6 |
| Plans complete | 4 |
| Tasks total | 7 |
| Tasks complete | 7 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 308s | 2 | 1 |
| 01 | 02 | 268s | 2 | 3 |
| 01 | 03 | 128s | 1 | 1 |
| 02 | 01 | 188s | 2 | 4 |

## Accumulated Context

### Key Decisions
- Callbacks on GroupQueue (not direct import) — keeps GroupQueue decoupled from session-awareness
- onContainerStart fires in registerProcess (not runForGroup) — both containerId and groupFolder known
- onContainerExit fires before containers.delete in finally — slot data still available
- readActiveSessionsFile validates JSON shape, returns empty on corrupt — defensive for container-side readers
- ContainerSlot map replaces active boolean for multi-container support
- pendingRegistrations map bridges containerId from runForGroup to registerProcess
- containerId parameter made optional on public API for backward compatibility
- Idle container reuse checked before global cap (no new slot cost)
- Extract containerId from processMessagesFn mock calls for precise slot targeting in tests
- Use completion callback arrays for concurrent container control in tests
- Fresh session per container (sessionId=undefined) for CONC-02 — idle-reuse containers already have session internally
- Task session logic preserved — context_mode 'group' resumes group session, 'isolated' fresh
- QueuedTask.fn receives containerId from GroupQueue.runTask for explicit threading

### Technical Notes
- `session-awareness.ts` writes `data/ipc/{group}/active_sessions.json` with atomic temp+rename
- GroupQueue has `onContainerStartFn` and `onContainerExitFn` optional callbacks
- index.ts wires callbacks at module level after `const queue = new GroupQueue()`
- 382/382 tests pass (371 existing + 11 new session-awareness tests)
- GroupQueue now uses `containers: Map<string, ContainerSlot>` per group — multi-slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` finds any idle non-task container and pipes to it
- `closeStdin()` can target a specific container via containerId or first idle
- `registerProcess()` uses pendingRegistrations bridge for containerId flow
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`type: 'task'`) reject `sendMessage()` — this stays
- `setProcessMessagesFn` callback now includes `containerId` parameter
- 382/382 tests pass (was 371, +11 session-awareness)
- Test suite covers: CONC-01, CONC-04, CONC-05, COMPAT-01 + all existing concepts
- processGroupMessages now receives containerId from GroupQueue, threads to all GroupQueue calls
- runAgent passes sessionId=undefined (CONC-02) and containerId to registerProcess
- SchedulerDependencies.onProcess includes containerId parameter
- QueuedTask.fn signature is (containerId: string) => Promise<void>

### Blockers
- (none)

### TODOs
- (none)

## Session Continuity

### Last Session
- 2026-03-11T21:03:22Z

### Handover Notes
- Phase 01 complete: All 3 plans done (01-01, 01-02, 01-03)
- Plan 02-01 complete: Session awareness file writer + GroupQueue lifecycle hooks
- active_sessions.json written on container start, cleaned on exit
- Next: Plan 02-02 — Container-side session reading + end-to-end validation
