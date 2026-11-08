---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Add Google Gemini 3.5 Transcribe Live as a built-in dictation provider (#3708). `GEMINI_API_KEY` registers it as `gemini`; `VOICE_PROVIDER=gemini` selects it, and without `VOICE_PROVIDER` it is used only when `DEEPGRAM_API_KEY` is unset, so Deepgram keeps precedence. The key stays on the server: each take mints a single-use ephemeral token whose constraints lock `gemini-3.5-transcribe-live`, text output and the transcription config (SMART by default, the brain's keyterms as vocabulary, at most 100 terms of 64 bytes). Any mint failure is the session route's 500 `{ error: "Gemini dictation session failed" }`, with neither the key nor Google's text. The browser's `gemini` client streams 16 kHz mono PCM16 in 100 ms frames, resampled from the hardware rate, with bounded pre-setup buffering, handshake, upload backlog and Done drain; interim text replaces the partial and each final commits once. Gemini cannot transcribe saved recordings. Live conversation's microphone capture now shares the same worklet and resampler, unchanged byte for byte.

SDK additions: optional `SpeechProvider.label` and `destination`, `createSession({ mode?: "smart" | "verbatim" })`, and `SpeechCapabilities.smartTranscription`. The server validates the new optional fields, and `runSpeechProviderContract` checks their types and that a SMART provider mints for both modes. Keyless tests prove protocol and resource behaviour only; acceptance by Google, accuracy and latency are qualified separately.
