---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Publish sealed reference-pool roots through per-domain view directories. `poolPublish` moves a sealed source root into its view once and swaps a plain name to it atomically, so a worker that binds the whole view reads a refreshed source on its next path read while open files keep their revision and staging never appears. `poolUnpublish` removes a name, `poolWithdraw` moves a root out of its view so it is unreachable by name or identity, releasing a root removes its names first, and `NativePoolRecord` gains `view`. The pool's `roots` and `views` directories join the mandatory worker masks.
