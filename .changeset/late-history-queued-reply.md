---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
---

Keep queued replies visible when a reconnect history read overlaps turn completion. Re-read an invalidated snapshot once and refuse a second invalidated snapshot instead of replacing newer delivered messages.

Preserve the live assistant message when refreshed history inserts its missing user row.
