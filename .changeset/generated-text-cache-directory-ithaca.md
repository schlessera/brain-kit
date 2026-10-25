---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Keep the committed generated-text caches in their own `.brain-cache/` directory: `.context-cache.jsonl` becomes `.brain-cache/contexts.jsonl` and `.asset-cache.jsonl` becomes `.brain-cache/assets.jsonl`. Breaking before 1.0, ruled in #2692 (option B, delivered in #2725): the location of committed files changes. The line format and every CLI, MCP and HTTP shape are unchanged. An existing clone keeps every cached context and asset description: reads count the old root-level files, and the next index run (or `brain doctor --fix`, new check `legacy-caches`) moves every line into the new file and deletes the old one. The move is idempotent and keeps union-merged lines, and `brain sync` treats the old names as derived caches, so a merge with a clone that still writes them keeps both sides. The template ships the empty caches in `.brain-cache/` with `merge=union` for the new paths, and `brain doctor --fix` adds those lines to an existing brain. While a governance policy names provider folders, every governed writer retains `.brain-cache/` beside `.brain-index/`, a hosted or autonomous turn that masks any provider folder sees it as an empty read-only folder, and a turn allowed every provider folder sees the real caches. A root-level cache from an earlier release keeps its file mask on every turn under a provider rule. ui-server starts one index run at boot when such a file is present.
