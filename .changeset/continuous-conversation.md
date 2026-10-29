---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
---

BREAKING: live conversation retains microphone consent through routine reply
interruption, Stop reply and recoverable visibility/transport/resync transitions
instead of requiring repeated Resume. Manual Mute and Leave remain authoritative.
Local reply audio uses bounded automatic recovery with a separate manual output
recovery action on timeout; delayed interrupted audio can occasionally pass.
Contextual recognition uses bounded recent history rather than a growing review
buffer. Permission authority, host serialization and no-replay guards remain.

Preserve effective agent-profile disclosure metadata across recovery and retain
same-entry openings while hidden, without weakening stale-capture, Mute, Leave
or authentication fences.
