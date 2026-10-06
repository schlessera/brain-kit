---
"@schlessera/brain-ui-kit": minor
---

Add the working-session strip and the shared row above the composer (D52). `ComposerRow` lays out two hard halves with an 8px gutter and disappears when both are empty. `SessionStrip` fills the left half: one or two 44px pills, or the most urgent pill and a summary that opens a focus-trapped `Working` sheet listing every session, and a single 44px summary while the keyboard is up. It prints each tracker state's word, tone and icon and is one roving tab stop. `ListRow` gains `density="pill"`, which draws two lines in a half under 240px and one line otherwise, plus `name`, `tabStop` and `onFocus`. The icon map gains eight session-state keys, and `describeWorkingSession` exports the state vocabulary for other surfaces.
