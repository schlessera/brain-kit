---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-kit": minor
---

Use the shared Overlay for app sheets, dialogs, fullscreen tools and panels. Escape dismisses only the topmost surface, modal focus stays inside and returns on dismissal, and destination panels keep the phone bar and rail operable. Palette and More actions run after closing. Expose the overlay surface ref and destination heading for app navigation adapters.

CommandPalette no longer carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in Overlay to supply modal semantics and focus management. This standalone-consumer behavior change ships in a pre-1.0 minor.

Credential and created-handoff focus destinations use deferred focus getters, preserving their targets when the owner unmounts.
