---
"@schlessera/brain-ui-server": patch
---

A Grep content row whose text contains a clock time or another colon-number-colon run no longer restricts the chat when exactly one of its candidate filenames is an existing file in the brain. Every candidate keeps its marks, and several existing candidates, missing file evidence, a masked path or a symlink still leave coverage unknown. A strict worker's candidates are checked in the checkpoint it searched.
