---
"@schlessera/brain": patch
---

`@schlessera/brain/internal` no longer re-exports `resolveCompletionProvider` (#4930). No package imported it from that entry: the video module takes it from `@schlessera/brain/module`, which keeps it. The internal entry is not a supported API.
