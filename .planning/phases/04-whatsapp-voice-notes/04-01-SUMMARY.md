---
phase: 04-whatsapp-voice-notes
plan: 01
subsystem: channels
tags: [whatsapp, baileys, voice-notes, audio, ipc, ptt]

# Dependency graph
requires: []
provides:
  - Optional sendAudio method on Channel interface
  - WhatsApp voice note sending via Baileys ptt flag
  - send_audio IPC message handler with auth rules
  - routeOutboundAudio function in router.ts
  - media/ IPC subdirectory for audio file staging
affects: [04-02, container-agent-runner]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Audio sent via Baileys ptt:true for inline playable voice notes'
    - 'IPC audio files staged in data/ipc/{group}/media/ and cleaned up after sending'
    - 'No queuing for audio — drop on disconnect (unlike text messages)'

key-files:
  created: []
  modified:
    - src/types.ts
    - src/channels/whatsapp.ts
    - src/router.ts
    - src/ipc.ts
    - src/index.ts
    - src/container-runner.ts
    - src/ipc-auth.test.ts

key-decisions:
  - 'No retry/queuing for audio — large and ephemeral, caller can retry'
  - 'Same authorisation rules for send_audio as send_message — isMain or same group folder'
  - 'Audio files cleaned up immediately after sending to avoid disk accumulation'

patterns-established:
  - 'Channel interface optional methods: sendAudio follows setTyping/syncGroups pattern'
  - 'IPC media staging: audio files placed in media/ subdirectory, referenced by filename in JSON'

# Metrics
duration: 2min 31s
completed: 2026-03-28
---

# Phase 4 Plan 1: WhatsApp Voice Note Sending Infrastructure Summary

**Host-side voice note sending via Baileys ptt flag with IPC audio handler and channel routing**

## Performance

- **Duration:** 2 min 31 s
- **Started:** 2026-03-28T14:33:06Z
- **Completed:** 2026-03-28T14:35:37Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Channel interface extended with optional `sendAudio(jid, audio, mimetype?)` method
- WhatsAppChannel implements voice note sending using Baileys `{ audio, ptt: true }` for inline playback
- IPC handler processes `send_audio` messages with same authorisation rules as text messages
- Audio files read from `data/ipc/{group}/media/`, sent, and cleaned up automatically
- `routeOutboundAudio` function routes audio to the correct channel
- `media/` IPC subdirectory created automatically alongside `messages/` and `tasks/`

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sendAudio to Channel interface and WhatsApp implementation** - `3266cb2` (feat)
2. **Task 2: Add send_audio IPC handler and audio routing** - `5b17b5b` (feat)

## Files Created/Modified

- `src/types.ts` - Added optional `sendAudio` method to Channel interface
- `src/channels/whatsapp.ts` - Implemented `sendAudio` using Baileys ptt:true
- `src/router.ts` - Added `routeOutboundAudio` function
- `src/ipc.ts` - Added `sendAudio` to IpcDeps, `send_audio` message handler
- `src/index.ts` - Wired `sendAudio` dep via `routeOutboundAudio`
- `src/container-runner.ts` - Added `media/` directory creation in IPC namespace
- `src/ipc-auth.test.ts` - Added `sendAudio` mock to test deps

## Decisions Made

- No retry/queuing for audio — audio is large and ephemeral, unlike text messages. If the connection is down, log a warning and drop. The caller (container agent) can retry.
- Same authorisation rules for `send_audio` as `send_message` — main group can send to any JID, non-main groups can only send to their own JID.
- Audio files cleaned up via `fs.unlinkSync` immediately after successful send to prevent disk accumulation.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Host-side infrastructure complete — container agents can now trigger voice note sending via IPC
- Plan 04-02 (container-side TTS skill) can build on this to generate and send audio from within containers
- The `media/` directory is ready for container agents to write audio files into

---

## Self-Check: PASSED

All 7 modified files confirmed present on disk. Both task commits (3266cb2, 5b17b5b) verified in git log. Build clean, 352 tests passing.

---

_Phase: 04-whatsapp-voice-notes_
_Completed: 2026-03-28_
