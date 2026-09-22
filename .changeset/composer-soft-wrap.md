---
"@schlessera/brain-ui-kit": patch
---

The composer's field grows with the text it displays, wrapped lines included,
up to its five-row cap, and shrinks back when the draft does. It used to grow
only on explicit newlines, so a paragraph typed into a phone-width field
scrolled inside one visible line. Sizing is `field-sizing: content` on a
controlled value with text in it — no ref, no measuring, no layout effect, so a
keystroke still costs one render — with the newline count kept on `rows` as the
floor a browser without `field-sizing` falls back to. `maxRows` now also caps
soft-wrapped growth, at that many whole lines or the design's 96px ceiling,
whichever is smaller — the same heights the previous constant cap produced.
