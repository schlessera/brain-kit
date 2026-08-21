---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-module-jobs": patch
---

Fix per-connection protocol state never reaching the WS dispatcher (declared
protocolRev was dropped, so the rev-3 turnId-echo requirement was never
enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
dead imports/variables surfaced by the new oxlint gate.
