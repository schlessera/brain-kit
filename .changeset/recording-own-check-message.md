---
"@schlessera/brain-ui-react": patch
---

A recording action refused because this page is still checking its own saved recordings now says "Recordings are still being checked. Try again in a moment." instead of "Recording in another Brain tab". The refusal is still immediate; locking and timing are unchanged. Another tab, another root's recordings store on the same page, and a recording in progress in any tab keep "Recording in another Brain tab".
