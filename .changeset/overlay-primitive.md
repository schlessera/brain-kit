---
"@schlessera/brain-ui-kit": minor
---

Add the controlled Overlay primitive with four variants, native modal focus and stacking, destination-panel inertness, and named document layer tokens. BottomSheet supports an optional close control; CommandPalette supplies group semantics inside its owning overlay.

CommandPalette no longer carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in Overlay to supply modal semantics and focus management. This standalone-consumer behavior change ships in a pre-1.0 minor.
