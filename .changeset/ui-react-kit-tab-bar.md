---
"@schlessera/brain-ui-react": minor
---

First step of the app onto the design kit: `@schlessera/brain-ui-kit` is a
dependency, its `tokens.css` is part of the app stylesheet, and the phone's
bottom navigation is the kit's `TabBar` (roving tab stop, amber active slot,
red inbox badge; the More menu stays app-owned). Settings gains a three-way
theme toggle (system / paper / dark), persisted per root and written to
`<html data-theme>` by `AppShell`.
