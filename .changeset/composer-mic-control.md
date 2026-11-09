---
"@schlessera/brain-ui-kit": minor
---

`Composer` can host the hold-to-talk `MicButton` (#3727). The new optional `micControl` prop places a caller-drawn mic in the mic slot. The field grows from 46px to 54px to fit the 44px target, and on a multi-line draft attach, the mic and Send sit on the last line. While `micControl` is set, `mic`, `onMic` and `micLabel` are ignored. Without it, the composer is unchanged.
