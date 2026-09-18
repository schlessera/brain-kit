---
"@schlessera/brain-ui-react": minor
---

The desktop rail is the kit's `SideRail`: five destinations (Chat, Activity
with the inbox count, Files, Graph, Settings) reachable by ⌘1–⌘5 or Ctrl,
collapsed to the 60px icon rail below 900px and expanded above, with the
socket state on the wordmark's line. The actions the old rail carried — New
chat, Sessions, Sync, the daily briefing, Search, Add a note, Statistics —
move to a ⌘K palette on the kit's `CommandPalette`, which filters as you
type, runs the selected row on ⏎ and closes on esc; Sync shows its effect
chip, and the commands that need the socket are left out while it is down.

`theme.css` now imports the kit's `tokens.css` itself, so a Tailwind consumer
that imports only `theme.css` gets the `--bk-*` values the kit components
read; before, such a consumer rendered every kit surface colourless.
