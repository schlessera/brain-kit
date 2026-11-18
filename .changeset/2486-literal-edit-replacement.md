---
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-ui-server": patch
---

`edit_file` now writes `new_string` exactly as given. Before, `$$`, `$&`, `` $` `` and `$'` in it were expanded as replacement patterns, so LaTeX display math, a price like `$$5` or a shell snippet changed on its way to disk. This applies to the pi backend's direct edit and to the hosted application route. The Claude backend now also records the version of a native `Edit` from the same literal bytes the runtime wrote, so a later write to that file is no longer refused as stale.
