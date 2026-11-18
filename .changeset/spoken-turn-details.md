---
"@schlessera/brain-ui-kit": minor
---

`SpokenTurn` gains an optional `details` prop (#3728). A spoken turn with details renders one visually hidden "Details" stop that shows as a pill on keyboard focus or a 300ms hover, and opens the existing transcript details dialog from Enter, Space, Shift+F10, the ContextMenu key, a right-click or a 500ms touch long-press, with focus returning on close. A right-click with text selected inside the turn keeps the native menu, and no evidence glyph renders. `TranscriptQualifiers` gains `trigger?: "glyphs" | "reveal"`; the default `"glyphs"` is unchanged. The new `SpokenTurnDetails` type is exported.
