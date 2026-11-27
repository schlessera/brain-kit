---
"@schlessera/brain-ui-react": patch
---

Tool rows of a streaming answer no longer re-render on every frame (#4748). A completed row is memoized on its tool call, its timed view and safety-indicator list keep their identity across renders that change nothing, and a `bind()` renderer parses its payload once per tool-call object and output instead of once per header, meta line and output view on every render. Rows draw the same content; a call replaced by a new object, or a span whose timing moved, still redraws its row.
