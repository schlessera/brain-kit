---
"@schlessera/brain-ui-react": patch
---

Overlapping session-list refreshes share one request chain (#4754). A refresh asked for while one is in flight sends nothing and marks one follow-up, which runs after the in-flight chain settles and whose answer replaces it; `loading` stays true until the last chain settles, and a failed chain still runs its follow-up. Retained voice conversations collected across cursor pages are merged by id, so a repeated row is listed once. The route and the list's contents are unchanged.
