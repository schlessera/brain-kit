---
"@schlessera/brain-ui-react": minor
---

Keep the device screen awake during all dictation modes and live voice conversations using the Screen Wake Lock API (#5007).

- **Shared controller.** Added `createScreenWakeLock` in `packages/ui-react/src/voice/screen-wake-lock.ts` to request `navigator.wakeLock.request("screen")` when visible, re-acquire on `visibilitychange` return, release sentinels that resolve after cancellation or a newer generation, and degrade silently when unsupported or rejected.
- **Dictation.** Moved wake-lock ownership from `DeepgramClient` into `useDictation` / `dictation-capture`, covering Deepgram, Gemini Live, Web Speech, and custom registered ASR clients while listening and releasing on Done, Cancel, silence timeout, provider-ended stop, auth-lock, superseded start, and unmount.
- **Live conversation.** Held the screen wake lock in `createConversationClient` while a started conversation is active (including across Mute and transient reconnects), releasing it on Leave, dispose, principal change, disclosure/persona invalidation, and stopped/failure transitions.
