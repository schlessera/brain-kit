---
"@schlessera/brain-ui-kit": minor
---

New voice surface components (#3692) for the unified dictation and live-conversation experience. One mic and one field, with one colour language: amber for you and your mic, teal for brain and its voice, grey when nothing is heard, and red only for End and failures.

- `VoiceField`: three shapes. `compact` holds a fixed height while dictating, `tall` is the live panel, and `card` is for Start and notices.
- `VoiceText` and `VoiceMeter`: the words and the level meter.
- `VoiceStateLabel`: an icon and one word for each state.
- `VoiceControlButton`: the raised round controls.
- `MicButton`: the hold ring, the hint and a "Talk live…" action for keyboard and screen readers.
- `VoiceNotice`: a short card for prompts and failures.
- `StartCard`: the disclosure, Service row, persona list, recovery notices and Start button.
- Spoken-turn marks for the chat: `SpokenTurn`, `SpokenMark`, `UncertainWord`, `UnplayedText`, `CutOffTag`, `VoiceToolChip` and `ConversationEndDivider`.
- `VOICE_SKINS` and the `--bk-voice-*` tokens.
- Icon keys: `speaker`, `mic-off` and `interrupt`.

All of these are presentational only: plain props and callbacks, with no dictation or conversation client code. Nothing in the app uses them yet; the ui-react wiring follows in later releases.
