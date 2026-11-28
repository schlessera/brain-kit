---
"@schlessera/brain-ui-kit": patch
---

`StatusIndicator` and `TranscriptQualifiers` show their tooltip on the first hover after details close with the pointer away from the trigger, by Escape or the close button (#4935). Hover still waits for the pointer to leave and return when details close under a resting pointer.
