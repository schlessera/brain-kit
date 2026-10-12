---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

Add authenticated user history revert and quarantine restoration with raw-byte
stale-state checks, journaled Undo, and original-operation receipts. Running
turns finish before revert while new turns queue behind it. Existing retained
change readers expose single-file actions and one whole-turn review dialog;
partial, conflicting and unknown outcomes remain beneath the original turn.
