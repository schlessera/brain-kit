---
"@schlessera/brain-ui-react": minor
---

The desktop rail follows D52 §1. Its destinations are Chat, Sessions, Actions, Files and Settings on ⌘1–⌘5 (Sessions is ⌘2, Actions moves to ⌘3 and Files to ⌘4). Graph is no longer a destination: it stays in the palette's Jump to, with no key. Under the destinations, the rail draws Search, Add a note and the Daily briefing (printing `spends` and its unavailable reason) with the palette's own handlers; collapsed, it draws only Search and Add. The passive ⌘K cap is now an `All commands` button that opens this root's palette by click, tap, Enter or space. Closing the palette without running a row returns focus to what held it. The palette lists Sessions once, under Jump to, and prints destination keys only under a fine pointer, as the rail does.
