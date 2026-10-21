---
"@schlessera/brain-ui-server": patch
---

`app.close()` no longer waits indefinitely for brain CLI reads or a plain index run. In-flight runs get a 2 s grace period; then shared runs (reads and plain `index`, whose outputs are disposable) are cancelled. Runs that write Markdown or git are never cancelled by this; every other run keeps its existing shutdown behaviour.
