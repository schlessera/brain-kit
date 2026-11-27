---
"@schlessera/brain": patch
---

A targeted index run, and a complete run that finds a note unchanged, now resolve links through an alias that contains a line break as a fresh build does (#4876). Both take an unchanged note's aliases from the index, which stores them one per line, so such an alias came back as several keys, and a link to one of its lines resolved where a fresh build leaves it broken. This also affected the hygiene repair's post-check. When a note's stored name keys show that one of its aliases spans lines, the run now reads that note's aliases from its file. The stored format is unchanged.
