---
"@schlessera/brain-ui-server": patch
---

A turn data tree run whose worker is already gone when its request is written no longer ends the host process. Cancelling a turn while its data-tree worker was launching, or a worker that died before reading its request, made the write fail with `EPIPE`, and that unheard stream error was an uncaught exception in the server. The run now reports the cancellation, or the worker's missing answer, as before.
