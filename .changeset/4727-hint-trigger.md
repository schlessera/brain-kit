---
"@schlessera/brain-ui-kit": patch
---

`StatusIndicator` and `TranscriptQualifiers` share one hover-hint trigger (#4727). `TranscriptQualifiers` now follows the indicator's rearm rule: after its details close with the pointer still over the trigger, the tooltip waits until the pointer leaves and returns instead of reappearing at once. The two tooltip classes keep their names and share one rule body. No prop, export or class name changes.
