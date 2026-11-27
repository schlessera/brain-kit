---
"@schlessera/brain-backend-claude": patch
---

Acknowledging a turn's prepared prompt now walks the saved transcript from the end and parses only lines that name the owned message id (#4857). A damaged earlier line no longer stops the acknowledgement, so the next prompt no longer repeats host facts the model already received; a damaged candidate line is skipped.
