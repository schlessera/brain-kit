---
"@schlessera/brain-ui-kit": minor
---

The kit adds `StatusIndicator`, a compact status control for work the user cannot see, such as a draft saving or a deletion the host has not confirmed. A 20px glyph sits in a native 44px button. Each of its eight states (`active`, `queued`, `success`, `attention`, `unknown`, `failed`, `refused`, `idle`) has its own glyph and colour, and only `active` animates; with reduced motion it stays still. Hovering or focusing it shows a one-sentence summary. Clicking, tapping, Enter or Space opens details with each operation's facts and the actions the app supplies. Opening details never runs an action. With several operations it shows the most serious state and a count. The app supplies every state, so `unknown` is never shown as success. Existing components, including `StatusDot`, are unchanged.
