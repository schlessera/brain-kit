---
"@schlessera/brain": patch
---
Prune excluded directories before discovering index and media-reference files, preserving the existing corpus and ordering.

Skip filename byte sequences that cannot round-trip through UTF-8, so one unusual directory cannot block Markdown, asset or media-reference discovery. Valid UTF-8 names remain visible.
