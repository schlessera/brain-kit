---
"@schlessera/brain-ui-react": patch
---

A composer keystroke no longer re-renders the Sessions list (#4751). The list selects only the words it prints from the drafts (a session draft's age, an unbound draft's title and save state), so an edit that changes none of them leaves it idle, its date groups are memoized, a closed Sessions drawer computes no rows, and the Sessions pane is memoized against Chat's re-renders. The rows print as before.
