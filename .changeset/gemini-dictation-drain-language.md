---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
---

Gemini dictation finishes Done faster and no longer guesses the language. Google never sends `finished` or `turnComplete` after `audioStreamEnd`, so Done waited its full 3 s every time. Done now ends on the `generationComplete` that follows the last words, or after 300 ms of quiet when nothing is pending (#3768). The minted token now locks `languageCodes: ["en-US"]` and the client repeats it, matching Deepgram's fixed `en`. With automatic detection, a short English segment had come back as Spanish (#3769).
