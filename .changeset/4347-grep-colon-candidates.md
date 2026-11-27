---
"@schlessera/brain-ui-server": patch
---

A Grep content row whose text contains a clock time or another colon-number-colon run no longer restricts a governed chat when exactly one of its candidate filenames is an existing file in the view the worker searched. Every candidate keeps its marks, and several existing candidates, missing file evidence, a masked path, a symlink, a path that is not in normal form, or a search that named a single file still leave coverage unknown. A strict worker's candidates are checked in the checkpoint it searched.
