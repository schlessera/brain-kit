---
"@schlessera/brain-ui-react": patch
---

Pressing the destination already shown, by rail row, ⌘1–⌘5, the palette's Jump to or a phone bar slot, now scrolls it to its start and moves focus instead of doing nothing (D52 N3 and its addendum). Chat's start is its latest turn: it does what `Scroll to latest` does, then focuses a waiting approval or question, the latest turn's failure, or the composer with the caret at the end; on a phone focus stays on the Chat tab. Sessions focuses the running session, then the one in view. Actions, Files and Settings focus their selected run, file or section, and fall back to their heading. Nothing is closed or cleared. Run rows in Actions now carry `aria-current` for the run the detail shows.
