---
"@schlessera/brain-ui-react": minor
---

The composer has one mic for both voice modes (#3693). Tap it to dictate, as before. Hold it for 0.6 s and the ring fills, then the live-conversation Start sheet opens, with a light haptic where the device supports one. Releasing earlier is a tap, and moving off the mic cancels the hold. Nothing is captured during a hold: no microphone, voice-service connection or history read starts until you pick dictation or press Start. On a keyboard, Enter or Space on the mic dictates and Shift+Enter opens Start; screen readers get a "Talk live…" action. Where live conversation isn't set up, the ring still fills and a notice explains instead.

The attach menu no longer has a "Live conversation" row, and the paperclip's name is back to "Attach — photo, camera, files". The offline "Record on this device" mic has no hold.
