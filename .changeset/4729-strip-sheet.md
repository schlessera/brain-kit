---
"@schlessera/brain-ui-kit": patch
---

Internal: `PendingFollowUps` and `SessionStrip` share one hook for their sheet's focus and caret restore and their roving focus across redraws (#4729). Neither strip's props, markup or behaviour changes.
