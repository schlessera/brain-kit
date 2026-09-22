---
"@schlessera/brain-ui-react": patch
---

The printed keyboard shortcuts — the rail's `⌘1`–`⌘5`, the `a` / `d` caps on
approval buttons, and the "↑ ↓ to pick, ↵ to open" and "Ctrl/Cmd + ↵ to save"
hints — now appear only while the device has a fine pointer, so a tablet in
landscape no longer reads five shortcuts it cannot fire. Pairing a mouse or
keyboard brings them back live. The bindings themselves are unchanged: every
key still works in both states, and the single-key shortcuts switch in
Settings stays independent of the pointer.
