---
"@schlessera/brain-ui-react": minor
---

The phone bar is now Chat, Sessions, Actions, Files and More (D52). Sessions has a slot of its own and Graph has moved into More. More now holds Settings, Graph, Add a note, the Daily briefing, Sync and Brain statistics. The briefing always shows `spends` and Sync always shows `sync`, including when they cannot run. Each unavailable row gives the real reason: `needs the host` when offline, `a turn is running` while a turn streams. A Search disc sits left of New chat in an occupied chat below 480px. On the empty chat, the starting chips are the briefing (showing `spends`, disabled with its reason when it cannot run), Search and Add a note. Add a note replaces the statistics chip.

Every bar slot replaces any open panel, and tapping the slot you are already on no longer closes it. The Sessions, Files and Settings drawers now stop above the phone bar, so every slot stays one tap away while one of them is open. A Files or Sessions tap from a view that cannot show that panel lands in Chat with the panel open. The UI store gains `openPanel("sessions" | "files" | "settings")` for this. Closing More with Escape or the scrim returns focus to the More slot.
