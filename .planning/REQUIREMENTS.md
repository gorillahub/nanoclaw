# Requirements — NanoClaw Concurrent Sessions

## Source

REQ-2026-03-11-001

## v1 Requirements

### Concurrency (CONC)

**CONC-01: Multi-container GroupQueue**
Replace single-slot `active: boolean` per group with a multi-container model. Every inbound message spawns a new container if no container is idle-waiting. If a container is idle-waiting, pipe the message to it (current behaviour, cheaper).

**CONC-02: Independent Claude sessions**
Each concurrent container gets a fresh Claude session. No shared sessionId between concurrent containers. Session resumption only applies when reusing an idle-waiting container.

**CONC-03: Container lifecycle independence**
Each concurrent container has its own idle timeout, independent of other containers in the same group. Container exit/timeout doesn't affect sibling containers.

**CONC-04: Global cap enforcement**
Global `MAX_CONCURRENT_CONTAINERS` (default 5) continues to protect VPS resources. The cap applies across all groups, not per-group. Excess requests queue normally.

**CONC-05: Idle container reuse**
When a message arrives and a container for that group is idle-waiting, pipe the message to it rather than spawning a new container. This preserves existing behaviour and reduces resource usage.

### Observability (OBS)

**OBS-01: Session awareness file**
NanoClaw maintains `data/ipc/{group}/active_sessions.json` listing all currently running containers for that group — their container name, start time, type (message/task), and which repos they're writing to. File updated on container start/exit.

**OBS-02: Container reads session awareness on startup**
Each container reads the session awareness file on startup so it knows what other containers are doing. This enables behavioural conflict avoidance via prompt context.

### Compatibility (COMPAT)

**COMPAT-01: Single-session backward compatibility**
When only one message is active for a group, behaviour is identical to the current single-container model. No observable difference for the common case.

**COMPAT-02: Shared volume mounts preserved**
All containers for the same group get the same volume mounts (read-write). No mount-level isolation introduced. Conflict avoidance is behavioural via prompt context.

## v2 (Deferred)

- Per-group concurrency limits
- Git worktree isolation per container
- Container priority levels (urgent vs background)

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONC-01 | Phase 1 | Pending |
| CONC-02 | Phase 1 | Pending |
| CONC-03 | Phase 1 | Pending |
| CONC-04 | Phase 1 | Pending |
| CONC-05 | Phase 1 | Pending |
| OBS-01 | Phase 2 | Pending |
| OBS-02 | Phase 2 | Pending |
| COMPAT-01 | Phase 1 | Pending |
| COMPAT-02 | Phase 1 | Pending |
