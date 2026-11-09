---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
---

Gemini dictation finishes Done faster and recognizes English with a fixed language hint. Google never sends `finished` or `turnComplete` after `audioStreamEnd`, so Done waited its full 3 s every time. Done now ends as soon as Google's answer reaches the end of the stream, and otherwise after 300 ms of quiet. Voice the microphone heard that Google has not yet signalled holds Done in a 1.5 s window, so words spoken just before Done are less likely to be cut off. The 3 s cap still bounds every wait (#3768). The minted token now locks a fixed English recognition hint, `languageCodes: ["en-US"]`, and the client repeats it, matching Deepgram's fixed `en`. With automatic detection, a short English segment had come back as Spanish (#3769).
