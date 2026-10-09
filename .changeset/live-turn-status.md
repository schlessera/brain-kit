---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

Use StreamingAnswer for first-content, approval-wait and retry status while
preserving rich transcript rendering and the composer's single Stop control.
Show only measured elapsed time and announce only phase changes.

Approved pre-1.0 breaking migration: StreamingAnswer no longer supplies example
phase, target, elapsed, answer or cost. Pass those facts explicitly where known.
The polite live region contains only the phase word. Set the new `pulse` prop
to false for a static decision-wait dot.
