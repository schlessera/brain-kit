---
"@schlessera/brain-ui-react": patch
---

Bind search, capture, sync and briefing requests to their UI root. Switching
roots clears stale results and capture completions; cancelling or replacing a
stream closes its reader without allowing old responses to overwrite the new
panel or disable its Cancel button.
