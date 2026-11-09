---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
---

Gemini dictation finishes Done faster and recognizes English with a fixed language hint. Google never sends `finished` or `turnComplete` after `audioStreamEnd`, so Done waited its full 3 s every time. Done now ends as soon as Google has answered for all the speech the microphone heard: on `generationComplete` and the `ACTIVITY_END` that covers the last voiced audio, or after 300 ms of quiet when nothing is pending. Voice that Google has not signalled yet keeps Done open for up to 1.5 s, so the last words are not cut off (#3768). The minted token now locks a fixed English recognition hint, `languageCodes: ["en-US"]`, and the client repeats it, matching Deepgram's fixed `en`. With automatic detection, a short English segment had come back as Spanish (#3769).
