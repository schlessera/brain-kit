---
"@schlessera/brain": patch
---

Give Gemini the installed brain agent contract in GEMINI.md during skills sync,
replacing the redundant legacy Skills index. Preserve all text outside managed
blocks, refuse ambiguous markers, and refresh the contract after package upgrades
without rewriting unchanged files.
