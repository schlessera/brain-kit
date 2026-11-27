---
"@schlessera/brain": patch
---

A targeted index run (`paths`) no longer scans `documents` three times or runs one query per unnamed document (#4779). The rows the run loads once now carry each document's kind, so the targeted plan and the deletion sweep decide from them, and the titles and aliases of the documents a targeted run does not read come from one statement. The index a run leaves and the stats it reports are unchanged.
