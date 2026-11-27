---
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-module-diagrams": patch
---

The jobs and diagrams manifests no longer load their runtime when core imports them, which it does in every `brain` process (#4797). The jobs settings form reads its board labels and browser needs from `JOB_BOARDS` instead of instantiating every scrape adapter, and the scoring migration loads `yaml` on its first call; the diagrams manifest loads its hygiene check, the SVG model and `yaml` only when an audit runs the check. The settings form, the migration and the hygiene findings are unchanged.
