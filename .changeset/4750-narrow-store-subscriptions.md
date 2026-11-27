---
"@schlessera/brain-ui-react": patch
---

The composer, the Actions page, a run's agent orbit and the tracker announcer now select only what they draw, so a streamed text delta or a live-conversation recognition fragment that changes none of it no longer re-renders them (#4750). The composer and the tracker announcer are memoized, so a frame of the session in view no longer reaches them through the chat page. Approvals, the conversation field, the resting mic and tracker announcements draw as before.
