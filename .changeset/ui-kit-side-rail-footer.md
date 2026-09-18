---
"@schlessera/brain-ui-kit": minor
---

`SideRail` takes `statusTone` (teal, amber or red) for the line under the
wordmark, and `null` for `spendPct` or `hint` draws no spend meter and no ⌘K
cap respectively — an app that tracks no spend or has no palette no longer
prints a value it cannot back. `undefined` keeps the fixture defaults the
stories render. `CommandPalette` takes `footHint` for the key legend, so an
app that does not bind ⌘⏎ does not print it.
