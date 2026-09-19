---
"@schlessera/brain-ui-react": patch
---

The Settings pane's Close button is inside the viewport again: the kit
`ScreenHeader` is `width: 100%`, so it needs a shrinking flex child around it
in the header row, as the Files pane already had. A closed drawer no longer
casts its 48px shadow into the viewport from just past the right edge: the
shadow fades with the slide-out, and a closed drawer takes no pointer events.
