---
"@schlessera/brain-ui-react": patch
---

The chat transcript is no longer rebuilt from every retained session on each write. The timeline now keeps one projection per session and projects a session again only when its messages, its streaming state or a voice input naming it changed. A write to one session leaves every other session's entries and array untouched, a write that changes no entry publishes nothing, and the chat page selects the session in view instead of filtering every session's entries, so a write to a background session no longer re-renders it. With eight sessions of 250 messages, replacing the last message of one went from about 2 ms to under 0.2 ms per write (desktop, timeline only).

Two consequences of keeping sessions apart. Grouping readings, attaching finish-only recognition and the interrupted-reply tag now look only at the session's own entries, so another session's entry that arrived in between no longer splits one reading in two. A recognition fragment whose reading takes its key from a later fragment keeps its place: before, the next write anywhere re-ranked it as a new arrival and moved it after the entries that followed.
