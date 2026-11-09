---
"@schlessera/brain-ui-react": minor
---

Dictation now happens in the voice field, and the dictation sheet and review card are gone (#3694). Tapping the mic replaces the composer with a compact field. It first shows "Connecting" and "Not listening yet", turns amber with "Listening" only once the microphone is open, goes quiet when nobody is speaking, and shows "Finishing" while the last words arrive. The field always says where the words go: "to Google Gemini", "via Deepgram", "browser speech · audio goes to Google" in Chrome, or "browser speech · sent by your browser" elsewhere. The ✓ ends the take, and so do 30 seconds of silence.

What you said goes straight into your draft as ordinary editable text, with the caret after it, and nothing is sent until you press Send. The mic then reads "Dictate more" and adds the next take after the words already there. The first take to a service shows a "Start dictation" card naming where the words go, before anything is requested or the microphone opens. If storing that acknowledgement fails, the card shows again on the next take. A refused microphone shows "Microphone is blocked". A take that stops early shows "Dictation stopped" with the words it kept, which are already in your draft, plus Try again and Dismiss. When no dictation service is chosen, or the saved one is gone, a card points to Settings.
