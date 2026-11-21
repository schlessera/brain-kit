---
"@schlessera/brain-ui-sdk": patch
---

`@schlessera/brain-ui-sdk/internal` now exports the `InferenceTimingMark` and `InferenceUsage` types that an egress record's timing and usage fields use. Without them, the `@schlessera/brain-ui-server` declaration build failed with TS2883.
