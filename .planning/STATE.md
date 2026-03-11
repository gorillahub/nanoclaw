# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** Roadmap created, awaiting Phase 1 planning
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 1 — Multi-Container GroupQueue
- **Plan:** None (not yet planned)
- **Status:** Not Started
- **Progress:** ░░░░░░░░░░ 0%

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 2 |
| Phases complete | 0 |
| Plans total | 0 |
| Plans complete | 0 |
| Tasks total | 0 |
| Tasks complete | 0 |

## Accumulated Context

### Key Decisions
- (none yet)

### Technical Notes
- GroupQueue currently uses `active: boolean` per group — single slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` pipes to idle containers, `closeStdin()` signals wind-down
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`isTaskContainer: true`) reject `sendMessage()` — this stays
- Existing test file (`group-queue.test.ts`) has 10 tests that enforce one-at-a-time-per-group — these need updating

### Blockers
- (none)

### TODOs
- (none)

## Session Continuity

### Last Session
- (project just created)

### Handover Notes
- Ready for `/gsd-plan-phase 1`
