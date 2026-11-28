---
"@schlessera/brain-ui-react": patch
---

An open Sessions drawer no longer rebuilds every row when its page re-renders, and a closed one no longer builds Working rows or indexes the session list on a tracker or session-list change (#4892). The backend name lookup the rows are memoized on now keeps its identity while the provider lists do.
