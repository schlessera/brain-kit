---
"@schlessera/brain-ui-server": patch
---

The `failure_recording` closing step now ends on a turn that answers. Its catalog writes commit off the event loop and were still pending when teardown checked them, so the step was never ended. It now ends when they are confirmed, after the terminal if need be, with no added close-path wait.
