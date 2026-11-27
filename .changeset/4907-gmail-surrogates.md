---
"@schlessera/brain-common": patch
"@schlessera/brain-ui-server": patch
---

Refuse unpaired UTF-16 surrogates in Gmail draft bodies, subjects and search queries as `invalid_input`, with a reason naming the field (#4907). This prevents UTF-8 encoding from replacing approved text before it reaches Gmail. Well-formed astral characters remain accepted and reach Gmail as the card shows them.
