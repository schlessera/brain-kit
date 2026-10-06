---
"@schlessera/brain-ui-kit": minor
---

`SideRail` gains optional rail acts and an operable All commands button (D52 §1). `acts` draws Search, Add a note and Daily briefing under the destinations as a vertical `Acts` toolbar with its own roving tab stop, printing each act's effect or cost and any unavailable reason at rest; the collapsed rail draws only effect-free acts. `onOpenPalette` replaces the passive ⌘K cap with an `All commands` button (`aria-keyshortcuts="Meta+K"`). The rail's middle now scrolls between a pinned wordmark and footer, and every new target is at least 44×44 under a coarse pointer. Callers that omit both props render as before. New export: `RailAct`.
