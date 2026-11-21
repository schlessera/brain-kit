---
"@schlessera/brain": patch
---
Prune excluded directories before discovering index and media-reference files, preserving the existing corpus and ordering.

Skip filename byte sequences that cannot round-trip through UTF-8 during Markdown and asset indexing. Media-reference inventories refuse an unrepresentable note or directory rather than claiming a complete inventory. Valid UTF-8 names remain visible.
