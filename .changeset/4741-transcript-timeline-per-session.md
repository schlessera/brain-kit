---
"@schlessera/brain-ui-react": patch
---

The chat transcript is no longer rebuilt from every retained session on each write. The timeline now keeps one projection per session and projects a session again only when its messages, its streaming state or a voice input naming it changed. A write to one session leaves every other session's entries and array untouched, a write that changes no entry publishes nothing, and the chat page selects the session in view instead of filtering every session's entries, so a write to a background session no longer re-renders it. With eight sessions of 250 messages, replacing the last message of one went from about 2 ms to under 0.2 ms per write (desktop, timeline only).

A voice reading drawn in several parts no longer changes order after activity in another session. Before, a write in any session could move one part of a reading after the others or past the entries that followed it, another session's message arriving in the middle of a reading split it in two, and another session's finish-only recognition could be attached to it. The timeline's flat `entries` list now holds each session's entries in turn instead of interleaving sessions; within a session the order is unchanged.
