---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-sdk": patch
---

Each meaning an answer block carried in ink colour alone now also draws a non-colour cue, derived from the tone the payload already carries, so it survives a grayscale print and a reader who cannot tell the hues apart. A judged value in `ComparisonTable`, `StatTiles`, `DataTable`, `Receipt`, `ContactCard` and the `TrendChart` delta draws its tone's glyph from the kit's icon vocabulary (red a triangle, gold a circle, amber a hand, purple a question mark; teal, blue, neutral, ink and dim draw none). `TimelineList` draws an event kind's glyph in place of the dot, `ScheduleList` leads a title with the claim on you, `StepList`'s current step wears a 2px ring, and a company or project `ContactCard` leads its role line with the kind word. No payload field, prop, token or icon key is added. `show_block`'s `bars` description now says a bar's tone is the class of work, not a judgement.
