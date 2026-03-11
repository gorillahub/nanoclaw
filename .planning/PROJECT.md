# NanoClaw Concurrent Sessions

## Core Value

Enable multiple concurrent agent containers per group so inbound messages are never blocked by long-running tasks. Any message spawns a new container immediately (up to the global cap), unless an idle container is already waiting to accept it.

## Problem Statement

NanoClaw currently enforces one active container per group. When Holly is running a 20-minute GSD execution, any new message (ad-hoc question, urgent alert, another GSD trigger) queues behind it. Users experience this as Holly being "busy" — potentially for 30+ minutes.

## Constraints

- Single Node.js process — no DB locking needed (SQLite is synchronous)
- Docker containers with stdio piping (stdin for secrets, stdout for OUTPUT_MARKERs)
- IPC uses file-based messaging (atomic write via temp+rename)
- Global MAX_CONCURRENT_CONTAINERS (default 5) already implemented and must continue to protect VPS resources
- VPS: 32GB RAM, comfortably handles 5 concurrent containers
- No changes to agent-runner inside containers
- No changes to MCP tools or channel adapters
- Conflict avoidance is behavioural (prompt context), not mount-level isolation

## Out of Scope

- Git worktrees or workspace-level isolation
- Per-group concurrency limits
- Changes to the agent-runner inside containers
- Changes to MCP tools or channel adapters

## Key Source Files

| File | Role |
|------|------|
| `src/group-queue.ts` | Core concurrency primitive — one-at-a-time enforcement (the main refactor target) |
| `src/index.ts` | Message loop, session management, `processGroupMessages` |
| `src/container-runner.ts` | Container spawning, volume mounts, secrets |
| `src/config.ts` | `MAX_CONCURRENT_CONTAINERS` and other settings |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/group-queue.test.ts` | Existing GroupQueue tests (must be updated) |

## Airtable Project Record

`recFADjzpnBY8NHh4` (Operations base)

## Area

operations
