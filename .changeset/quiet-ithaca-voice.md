---
"@schlessera/brain-ui-react": patch
---

Keep microphone capture open when user speech overlaps digitally silent live audio or a silent reply tail. Track potentially audible samples on the browser audio clock, flush currently queued output when the user takes the floor or a permission tone plays without retiring the provider's epoch-wide output identity, and preserve real reply interruption and explicit stop behavior. Start now waits visibly for readiness and resynchronization, opens capture when both complete, preserves an explicit Resume across late receipts from the old epoch, and reports microphone permission or device failures without reopening after mute or reconnect.
