---
"@schlessera/brain": patch
---

`brain skills sync` and `brain setup` no longer stop with an internal error for Codex when the installed `CONTRACT.md` cannot be read (#4713): `AGENTS.md` is left unchanged and the sync reports a warning, as it already did for `GEMINI.md`. The Gemini malformed-marker warning now names the block, as the Codex one does ("… for the contract block"). The four built-in emitters share one symlink loop and one managed-block edit; what they write is unchanged.
