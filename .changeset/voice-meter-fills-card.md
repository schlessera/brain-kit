---
"@schlessera/brain-ui-kit": patch
---

Voice surface review fixes (#3746):

- **Live cards.** The tall `VoiceField`'s meter now fills the whole card in every mode: the level bars, the thinking/working sweep, the muted line and the reconnecting hatch. A top fade across the label row keeps the state label readable.
- **Dictation.** While a state label shows (D3–D5), the compact field anchors the label to the top and the words to the bottom, over a fade that blends the meter into the field behind the words.
- **Text backgrounds.** Text in the field no longer has a solid background of its own. It reads through the fades and a soft halo in the field's colour.
- **Start card.** "What's shared ›" sits closer under Start, with its 44px target kept.
