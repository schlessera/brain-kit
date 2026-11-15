---
"@schlessera/brain-ui-server": minor
---

Attribute more of journal begin in a turn's lifecycle steps. The `journal` phase now also reports `observe_reserve` (the wait for room behind earlier checkpoint releases), `observe_release_reads`, `observe_worktrees`, and `observe_publish` and `observe_facts` beside `observe_record`. The record steps now repeat once per other active turn the observation records, and are absent when there is none.
