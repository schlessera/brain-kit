---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": patch
---
Let a user mark a brain file untrusted (#2673). Any principal that can read a file may mark it, and only the owner may clear a mark. A chat that then opens the file with its file tools records `taint` with `source: "user_marked"` and runs under the tainted session's outward and egress rules. Marks live in the UI database, survive a restart and `brain index --force`, and stay with their old path when a file moves, where only the owner sees them as missing. The capabilities note now names marked files among the untrusted sources.
