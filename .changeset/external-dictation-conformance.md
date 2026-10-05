---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Support external dictation providers through `createApp({ speechProvider })`,
with explicit-selection mismatch errors, session validation and no silent
fallback. Publish `runSpeechProviderContract` and `runAsrClientContract` with
keyless transport harnesses, and document the matching public client registry
and authoring types. Dictation interfaces remain experimental until 1.0;
live conversation and permission authority retain their separate boundaries.
