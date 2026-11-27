---
"@schlessera/brain": patch
---

`brain add --tags` no longer writes empty tags (#4711). It splits the list the way `brain_add` does: trimmed, with empty entries dropped, so `--tags "a,,b"` writes `[a, b]`, and a list with nothing left (`--tags ","`) means no tags were given, so the classifier's tags apply instead of two empty strings. `brain add` and `brain archive` now call the same operations as `brain_add` and `brain_archive`, and the read tools' stale-index warning is written once. No `--json` shape or MCP result changes.
