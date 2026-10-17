---
"@schlessera/brain-ui-sdk": patch
---

Preserve executable aliases already supplied by restricted workers’ read-only runtime view, avoiding startup failures when a system shell or owned runtime entry is a symlink. Keep temporary runtimes and host state isolated.
