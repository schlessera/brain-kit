---
"@schlessera/brain-ui-sdk": patch
---

The unsupported `@schlessera/brain-ui-sdk/internal` entry no longer re-exports 64 names that no other brain-kit package imports or reaches through its declarations (worker-area, turn-temp, state-limit, outward-classification and maintenance helpers among them), and `@schlessera/brain-ui-sdk/internal/client` drops `ShareTargetError` and `isShareTargetRequest`. The declarations themselves are unchanged. Internal entries carry no compatibility promise; the supported entries are unaffected.
