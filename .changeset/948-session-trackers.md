---
"@schlessera/brain-ui-react": minor
---

Track work left running in another session until you have seen it (D52 §4).
Leaving a session by New chat, by selecting another one, or by leaving the
page while its turn runs, is queued, waits on an approval or a question, or
has a send the host never acknowledged, now records a tracker for it. So
does work that starts in a session you are not looking at. A tracker's state
comes only from the host: its recovery envelope when it advertises
`sessionRecovery`, and the live frames between reads. The states, in display
order, are needs you, failed, unconfirmed, running, queued, unknown, can't
check, done and cancelled, and times are only ever the host's own. A tracker
clears only when Chat shows that session's latest turn, with the document
visible, no panel over it and the transcript at its end. Selecting the
session or being scrolled up does not count, and an older observation never
clears newer work. Each root stores only identifiers, under its own prefix
(`${storagePrefix}:trackers:v1`); a different principal or a revocation
deletes the set. Recovery reads never send a frame, select a session or
start a turn. The strip and pane that show trackers are separate work.
