---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Bound live dialogue failure drains, history/startup waits and application shutdown at the existing ten-second cleanup grace. Indeterminate writes stop only the failed epoch and remain owned until actual settlement; late commits are historical data, never replayed live effects. Add an honest indeterminate diagnostic and an exported storage-settlement error whose cleanup promise observes continuing real cleanup.
