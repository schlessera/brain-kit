---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-kit": patch
---

Internal: the composer returns focus to the mic, the live notice's OK and the capture notice's Dismiss by data attributes instead of by their accessible names or text (#4828). The kit's own composer mic now carries `data-composer-mic`, as the caller-supplied mic's slot already did, the hold-to-talk mic button carries `data-voice-mic`, and voice notice actions carry `data-voice-action`. Accessible names, labels and focus behaviour are unchanged.
